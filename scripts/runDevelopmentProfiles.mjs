import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  cpSync,
  createWriteStream,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { developmentProfile } from './developmentProfile.mjs';
import { createEvidenceDirectory } from './runExtensionHost.mjs';
import { root } from './upstream.mjs';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const nonce = randomBytes(16).toString('hex');
const hosts = [];
const profiles = [];
const result = {
  status: 'fail',
  nonce,
  started: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  profiles: [],
  completed: [],
  observations: [],
  leftovers: [],
};
const suiteDeadline = Date.now() + 240000;
const parent = process.env.DEVLOOM_EVIDENCE_DIR;
if (!parent || !isAbsolute(parent))
  throw new Error('Set an absolute external DEVLOOM_EVIDENCE_DIR');
const canonicalParent = realpathSync(parent);
const canonicalRoot = realpathSync(root);
if (canonicalParent === canonicalRoot || canonicalParent.startsWith(`${canonicalRoot}/`))
  throw new Error('Evidence must be outside the repository, including aliases');
const evidence = createEvidenceDirectory(canonicalParent);
const temporary = mkdtempSync('/tmp/dlg-profile-');
const workspace = join(temporary, 'workspace');
const runtime = join(temporary, 'broker');
const write = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};
async function waitFor(label, inspect, timeout = 45000) {
  const deadline = Math.min(suiteDeadline, Date.now() + timeout);
  while (Date.now() < deadline) {
    const found = inspect();
    if (found) return found;
    await delay(75);
  }
  throw new Error(`Profile host timeout: ${label}`);
}
function fixture(role) {
  const profile = developmentProfile(root, `qa-${nonce.slice(0, 12)}-${role}`);
  assert.equal(profile.created, true);
  const channel = join(evidence, role);
  mkdirSync(channel, { mode: 0o700 });
  const markerBytes = readFileSync(join(profile.path, '.devloom-owner.json'), 'utf8');
  write(join(profile.path, '.devloom-qa-owner.json'), { nonce });
  const extension = join(profile.extensions, 'devloom.development-profile-fixture-1.0.0');
  mkdirSync(extension, { mode: 0o700 });
  cpSync(join(root, 'dist/tests/developmentProfileHost.js'), join(extension, 'main.js'));
  write(join(extension, 'fixture.json'), { nonce, channel, workspace });
  write(join(extension, 'package.json'), {
    name: 'development-profile-fixture',
    publisher: 'devloom',
    version: '1.0.0',
    engines: { vscode: '^1.146.0' },
    main: './main.js',
    activationEvents: ['onStartupFinished'],
    contributes: {
      configuration: {
        properties: {
          'devloomProfileFixture.value': { type: 'string', default: null },
        },
      },
    },
  });
  const defaults = JSON.parse(readFileSync(profile.settings, 'utf8'));
  writeFileSync(
    profile.settings,
    `{
  // profile fixture ${nonce}
  ${Object.entries({
    ...defaults,
    'security.workspace.trust.enabled': false,
    'workbench.startupEditor': 'none',
    'devloomProfileFixture.sentinel': nonce,
  })
    .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)},`)
    .join('\n  ')}
}\n`,
  );
  const value = { ...profile, role, channel, markerBytes, mains: new Set() };
  profiles.push(value);
  result.profiles.push({
    id: profile.id,
    token: profile.token,
    path: profile.path,
    marker: profile.marker,
    markerBytes,
    ipc: profile.ipc,
  });
  return value;
}
function launch(profile, label) {
  const log = createWriteStream(join(evidence, `${label}.log`), { flags: 'wx', mode: 0o600 });
  const child = spawn(
    process.execPath,
    [join(root, 'scripts/devloom.mjs'), 'start', `--dev-profile=${profile.id}`, workspace],
    {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DEVLOOM_GIT_TEST_DIRECTORY: runtime },
    },
  );
  const host = { child, label, profile, closed: false, exit: null };
  host.completion = new Promise((done) => {
    child.once('error', (error) => {
      host.error = error.message;
    });
    child.once('close', (code, signal) => {
      host.closed = true;
      host.exit = { code, signal };
      log.end();
      write(join(evidence, `${label}-launcher.json`), {
        pid: child.pid,
        ...host.exit,
        error: host.error,
      });
      done(host.exit);
    });
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  hosts.push(host);
  return host;
}
async function activation(profile, host, previous = new Set()) {
  const value = await waitFor(`${host.label} activation`, () => {
    if (host.closed && host.exit.code !== 0) throw new Error(`Launcher failed: ${host.label}`);
    const names = readdirSync(profile.channel).filter(
      (name) => name.startsWith('activation-') && !previous.has(name),
    );
    if (!names.length) return;
    assert.equal(names.length, 1);
    return JSON.parse(readFileSync(join(profile.channel, names[0]), 'utf8'));
  });
  assert.equal(value.nonce, nonce);
  assert.equal(value.appName, 'Devloom IDE Dev');
  assert.ok(Number.isSafeInteger(value.mainPid) && value.mainPid > 1);
  assert.ok(alive(value.mainPid));
  if (host.mainPid === undefined) {
    const diagnostic = execFileSync(
      '/bin/ps',
      ['-p', String(value.mainPid), '-o', 'pid=,pgid=,comm='],
      { encoding: 'utf8' },
    ).trim();
    const fields = diagnostic.split(/\s+/);
    assert.equal(Number(fields[0]), value.mainPid);
    assert.equal(Number(fields[1]), host.child.pid);
    assert.match(diagnostic, /Code - OSS/);
    write(join(evidence, `${host.label}-native.json`), {
      diagnostic,
      launcherPid: host.child.pid,
      mainPid: value.mainPid,
    });
  }
  host.mainPid = value.mainPid;
  profile.mains.add(value.mainPid);
  return value;
}
async function stage(profile, active, name, action = 'read', value) {
  const request = { nonce, activation: active.activation, stage: name, action, value };
  const temporaryRequest = join(profile.channel, `request-${name}.json`);
  write(temporaryRequest, request);
  renameSync(temporaryRequest, join(profile.channel, 'request.json'));
  const response = await waitFor(name, () => {
    const path = join(profile.channel, `result-${name}.json`);
    return existsSync(path) && JSON.parse(readFileSync(path, 'utf8'));
  });
  assert.equal(response.nonce, nonce);
  assert.equal(response.activation, active.activation);
  assert.equal(response.stage, name);
  assert.equal(response.action, action);
  assert.equal(response.status, 'pass');
  assert.equal(response.mainPid, active.mainPid);
  assert.ok(response.observed >= active.started);
  assert.equal(response.workspace, realpathSync(workspace));
  assert.ok(response.globalStorageUri.startsWith(`${profile.userData}/`));
  assert.ok(response.storageUri.startsWith(`${profile.userData}/`));
  result.observations.push(response);
  return response;
}
function values(observation, expected) {
  for (const key of ['setting', 'globalState', 'workspaceState'])
    assert.equal(observation[key], expected);
}
async function quit(profile, active, host, name) {
  await stage(profile, active, name, 'quit');
  await waitFor(`${name} launcher close`, () => host.closed);
  assert.deepEqual(await host.completion, { code: 0, signal: null });
  await waitFor(`${name} native Main exit`, () => !alive(active.mainPid));
}
try {
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(runtime, { mode: 0o700 });
  const hooks = join(temporary, 'hooks');
  mkdirSync(hooks, { mode: 0o700 });
  execFileSync('git', ['-c', `core.hooksPath=${hooks}`, 'init', workspace], { stdio: 'pipe' });
  execFileSync('git', ['config', '--local', 'core.hooksPath', hooks], { cwd: workspace });
  writeFileSync(join(workspace, 'fixture.txt'), 'persistent profile fixture\n', {
    flag: 'wx',
    mode: 0o600,
  });
  const a = fixture('a');
  const b = fixture('b');
  let ownerA = launch(a, 'a-write');
  let activeA = await activation(a, ownerA);
  values(await stage(a, activeA, 'a-write', 'write', `a-${nonce}`), `a-${nonce}`);
  await quit(a, activeA, ownerA, 'a-first-quit');
  result.completed.push('a-write-clean-quit');
  const previousA = new Set(readdirSync(a.channel));
  ownerA = launch(a, 'a-reopen');
  activeA = await activation(a, ownerA, previousA);
  const restored = await stage(a, activeA, 'a-read');
  values(restored, `a-${nonce}`);
  const first = result.observations[0];
  assert.equal(restored.storageUri, first.storageUri);
  assert.equal(restored.globalStorageUri, first.globalStorageUri);
  assert.ok(readFileSync(a.settings, 'utf8').includes(`// profile fixture ${nonce}`));
  result.completed.push('a-native-persistence-jsonc');
  const ownerB = launch(b, 'b-owner');
  const activeB = await activation(b, ownerB);
  const isolated = await stage(b, activeB, 'b-initial');
  values(isolated, null);
  assert.notEqual(isolated.globalStorageUri, restored.globalStorageUri);
  assert.notEqual(isolated.storageUri, restored.storageUri);
  assert.notEqual(activeA.mainPid, activeB.mainPid);
  values(await stage(b, activeB, 'b-write', 'write', `b-${nonce}`), `b-${nonce}`);
  values(await stage(a, activeA, 'a-overlap'), `a-${nonce}`);
  result.completed.push('a-b-native-isolation-overlap');
  const beforeFollower = new Set(readdirSync(a.channel));
  const follower = launch(a, 'a-follower');
  await waitFor('ordinary follower close', () => follower.closed);
  assert.deepEqual(await follower.completion, { code: 0, signal: null });
  assert.ok(alive(activeA.mainPid));
  const reactivated = await activation(a, ownerA, beforeFollower);
  assert.equal(reactivated.mainPid, activeA.mainPid);
  assert.notEqual(reactivated.activation, activeA.activation);
  assert.notEqual(reactivated.extensionHostPid, activeA.extensionHostPid);
  activeA = reactivated;
  values(await stage(a, activeA, 'a-follower-read'), `a-${nonce}`);
  values(await stage(b, activeB, 'b-after-follower'), `b-${nonce}`);
  assert.equal(readFileSync(join(a.path, '.devloom-owner.json'), 'utf8'), a.markerBytes);
  assert.ok(readFileSync(a.settings, 'utf8').includes(nonce));
  result.completed.push('ordinary-follower-same-main-new-activation');
  await quit(b, activeB, ownerB, 'b-quit');
  await quit(a, activeA, ownerA, 'a-final-quit');
  result.completed.push('native-quit-b-before-a');
  result.status = 'pass';
} catch (error) {
  result.error = error instanceof Error ? error.message : 'Profile host failure';
} finally {
  for (const host of hosts.filter((item) => !item.closed)) {
    result.status = 'fail';
    result.forcedShutdown = true;
    try {
      process.kill(-host.child.pid, 'SIGTERM');
    } catch {}
  }
  await delay(1000);
  for (const host of hosts.filter((item) => !item.closed)) {
    try {
      process.kill(-host.child.pid, 'SIGKILL');
    } catch {}
  }
  await waitFor('owned launcher cleanup', () => hosts.every((host) => host.closed), 5000).catch(
    () => {},
  );
  let safe = hosts.every((host) => host.closed);
  for (const profile of profiles) {
    try {
      assert.ok([...profile.mains].every((pid) => !alive(pid)));
      assert.ok(hosts.filter((host) => host.profile === profile).every((host) => host.closed));
      assert.equal(
        readFileSync(join(profile.path, '.devloom-qa-owner.json'), 'utf8'),
        `${JSON.stringify({ nonce }, null, 2)}\n`,
      );
      assert.equal(
        readFileSync(join(profile.path, '.devloom-owner.json'), 'utf8'),
        profile.markerBytes,
      );
      assert.equal(developmentProfile(root, profile.id).created, false);
      rmSync(profile.path, { recursive: true });
    } catch {
      safe = false;
      result.status = 'fail';
      result.leftovers.push(profile.path);
    }
  }
  if (safe) rmSync(temporary, { recursive: true });
  else result.leftovers.push(temporary);
  result.finished = new Date().toISOString();
  write(join(evidence, 'run-result.json'), result);
}
process.stdout.write(
  `Development profile host ${result.status}: ${join(evidence, 'run-result.json')}\n`,
);
if (result.status !== 'pass') process.exitCode = 1;
