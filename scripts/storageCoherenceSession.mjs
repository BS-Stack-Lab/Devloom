import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { randomBytes, createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { launchOwned, groupMembers, probeProcess } from './localGitSession.mjs';
import { buildLocalArtifact, verifyInstalled } from './localExtensionArtifact.mjs';
import { localEnvironment, nativeRuntime } from './localExtensionInstall.mjs';
import { developmentArguments } from './developmentProfile.mjs';
import { root, upstream } from './upstream.mjs';

export const write = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
export async function waitFor(inspect, deadline) {
  const end = Math.min(deadline, performance.now() + 45000);
  while (performance.now() < end) {
    const value = await inspect();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error('STORAGE_STAGE_DEADLINE');
}
export function validateResponse(value, request, active) {
  for (const key of [
    'nonce',
    'activation',
    'window',
    'stage',
    'sequence',
    'action',
    'generation',
    'deleted',
  ])
    assert.equal(value[key], request[key], 'INVALID_RESPONSE_BINDING');
  for (const key of ['mainPid', 'extensionHostPid', 'workspace'])
    assert.equal(value[key], active[key], 'INVALID_RESPONSE_PROCESS');
  assert.ok(
    value.observed >= active.started && value.observed <= Date.now(),
    'INVALID_RESPONSE_TIME',
  );
  assert.equal(value.status, 'pass', 'NATIVE_STORAGE_ASSERTION_FAILED');
  return value;
}
export function assertSecretFree(paths, nonce) {
  const needles = [];
  for (let generation = 0; generation <= 64; generation++) {
    const value = `storage-fixture/${nonce}/${generation}/λ`;
    needles.push(
      value,
      Buffer.from(value).toString('base64'),
      Buffer.from(value).toString('hex'),
      encodeURIComponent(value),
      JSON.stringify(value).slice(1, -1),
      createHash('sha256').update(value).digest('hex'),
    );
  }
  let total = 0;
  const scan = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('PRIVACY_SCAN_SYMLINK');
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) scan(join(path, name));
      return;
    }
    if (!stat.isFile()) return;
    total += stat.size;
    if (stat.size > 8 * 1024 * 1024 || total > 64 * 1024 * 1024)
      throw new Error('PRIVACY_SCAN_BOUND');
    const bytes = readFileSync(path);
    if (needles.some((needle) => bytes.includes(Buffer.from(needle))))
      throw new Error('PRIVACY_SCAN_FAILED');
  };
  for (const path of paths) scan(path);
  return { secretFree: true, filesBytes: total };
}
export class StorageSession {
  constructor(parent) {
    if (!parent || !isAbsolute(parent)) throw new Error('EXTERNAL_EVIDENCE_REQUIRED');
    const canonical = realpathSync(parent);
    const source = realpathSync(root);
    if (canonical === source || canonical.startsWith(`${source}/`))
      throw new Error('EXTERNAL_EVIDENCE_REQUIRED');
    const runtime = nativeRuntime(root);
    this.evidence = mkdtempSync(join(canonical, 'storage-coherence-'));
    this.temporary = realpathSync(mkdtempSync('/tmp/dsc-'));
    this.nonce = randomBytes(16).toString('hex');
    this.temporaryIdentity = lstatSync(this.temporary);
    this.marker = { nonce: this.nonce, root: source };
    write(join(this.temporary, '.owner.json'), this.marker);
    this.hosts = [];
    this.profiles = [];
    this.counter = 0;
    this.deadline = performance.now() + 240000;
    this.env = localEnvironment(root);
    this.runtime = runtime;
    const broker = join(this.temporary, 'broker');
    mkdirSync(broker, { mode: 0o700 });
    this.env.DEVLOOM_GIT_TEST_DIRECTORY = broker;
  }
  async profile(role, windows) {
    const directory = join(this.temporary, `p-${this.nonce}-${role}`);
    mkdirSync(directory, { mode: 0o700 });
    const userData = join(directory, 'u');
    const extensions = join(directory, 'extensions');
    mkdirSync(join(userData, 'User'), { recursive: true, mode: 0o700 });
    mkdirSync(extensions, { mode: 0o700 });
    write(join(directory, '.owner.json'), this.marker);
    write(join(userData, 'User/settings.json'), {
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
      'extensions.autoCheckUpdates': false,
      'extensions.autoUpdate': 'off',
      'chat.disableAIFeatures': true,
      'security.workspace.trust.enabled': false,
      'workbench.startupEditor': 'none',
      'window.openFoldersInNewWindow': 'on',
      'window.restoreWindows': 'none',
      'git.autofetch': false,
    });
    const channel = join(this.evidence, role);
    mkdirSync(channel, { mode: 0o700 });
    const workspaces = {};
    for (const window of windows) {
      workspaces[window] = join(this.temporary, `workspace-${role}-${window}`);
      mkdirSync(workspaces[window], { mode: 0o700 });
      mkdirSync(join(channel, window), { mode: 0o700 });
    }
    const profile = {
      directory,
      identity: lstatSync(directory),
      userData,
      extensions,
      channel,
      workspaces,
      sequences: {},
      seen: new Set(),
    };
    this.profiles.push(profile);
    const artifact = buildLocalArtifact(root, {
      manifest: {
        name: 'storage-coherence-fixture',
        publisher: 'devloom',
        version: '1.0.0',
        engines: { vscode: '^1.146.0' },
        main: './main.js',
        activationEvents: ['onStartupFinished'],
      },
      files: {
        'main.js': join(root, 'dist/tests/storageCoherenceFixture.js'),
        'storageCoherenceCases.js': join(root, 'dist/tests/storageCoherenceCases.js'),
      },
      data: { 'fixture.json': { nonce: this.nonce, channel, workspaces, profile: userData } },
    });
    profile.artifact = artifact;
    const invoke = async (extra) => {
      const host = this.launch(profile, null, [this.runtime.entry, ...extra], true);
      const state = await host.completion;
      if (state.status !== 'pass') throw new Error('NATIVE_INSTALL_FAILED');
      return host.output.split(/\r?\n/);
    };
    await invoke([
      `--install-extension=${artifact.archive}`,
      '--do-not-include-pack-dependencies',
      '--do-not-sync',
    ]);
    assert.ok(
      (await invoke(['--list-extensions', '--show-versions'])).includes(
        `${artifact.id}@${artifact.version}`,
      ),
    );
    const installed = join(extensions, `${artifact.id}-${artifact.version}`);
    assert.ok((await invoke([`--locate-extension=${artifact.id}`])).includes(installed));
    verifyInstalled(installed, artifact);
    const registry = JSON.parse(readFileSync(join(extensions, 'extensions.json'), 'utf8'));
    assert.equal(
      registry.filter(
        (entry) => entry.identifier.id === artifact.id && entry.version === artifact.version,
      ).length,
      1,
    );
    write(join(channel, 'installation.json'), {
      installed: true,
      id: artifact.id,
      digest: artifact.digest,
    });
    return profile;
  }
  launch(profile, window, extra = [], cli = false) {
    const label = `launch-${++this.counter}`;
    const evidence = join(this.evidence, label);
    mkdirSync(evidence, { mode: 0o700 });
    const host = launchOwned({
      command: cli ? this.runtime.executable : join(upstream, 'scripts/code.sh'),
      args: [
        ...extra,
        ...developmentArguments(root, profile, window ? profile.workspaces[window] : null),
      ],
      cwd: upstream,
      env: cli ? { ...this.env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'development' } : this.env,
      fixtureRoot: this.temporary,
      profile: profile.userData,
      nonce: this.nonce,
      sessionId: label,
      sourceRoot: root,
      evidence,
      timeoutMs: Math.max(1, Math.min(cli ? 45000 : 240000, this.deadline - performance.now())),
    });
    host.profileRecord = profile;
    host.window = window;
    this.hosts.push(host);
    return host;
  }
  async activation(profile, window, owner) {
    const channel = join(profile.channel, window);
    const active = await waitFor(() => {
      const failed = readdirSync(channel).some((name) => name.startsWith('control-failure-'));
      if (failed) throw new Error('NATIVE_CONTROL_FAILED');
      const names = readdirSync(channel).filter(
        (name) => name.startsWith('activation-') && !profile.seen.has(name),
      );
      if (!names.length) return;
      assert.equal(names.length, 1);
      profile.seen.add(names[0]);
      return JSON.parse(readFileSync(join(channel, names[0]), 'utf8'));
    }, this.deadline);
    assert.equal(active.nonce, this.nonce);
    assert.equal(active.window, window);
    assert.equal(active.workspace, profile.workspaces[window]);
    assert.equal(active.appName, 'Devloom IDE Dev');
    assert.equal(active.capability, true, 'SECURE_PERSISTED_BACKEND_REQUIRED');
    assert.equal(active.status, 'pass');
    assert.ok(active.started >= owner.launched);
    const main = probeProcess(active.mainPid);
    const extension = probeProcess(active.extensionHostPid);
    assert.equal(main.uid, process.getuid());
    assert.equal(main.detachedPgid, owner.child.pid);
    assert.equal(extension.detachedPgid, owner.child.pid);
    assert.ok(main.args.split(/\s+/).includes(`--user-data-dir=${profile.userData}`));
    owner.nativeMain = main;
    profile.sequences[active.activation] = 0;
    write(join(channel, `verified-${active.activation}.json`), { main, extension, active });
    return active;
  }
  async stage(profile, active, action, generation = 0, deleted = false) {
    assert.ok(performance.now() < this.deadline, 'SUITE_DEADLINE');
    const sequence = ++profile.sequences[active.activation];
    const stage = `stage-${active.activation}-${sequence}-${action}`;
    const request = {
      nonce: this.nonce,
      activation: active.activation,
      window: active.window,
      stage,
      sequence,
      action,
      generation,
      deleted,
    };
    const channel = join(profile.channel, active.window);
    const staged = join(channel, `${active.activation}-${stage}-request.json`);
    write(staged, request);
    renameSync(staged, join(channel, 'request.json'));
    const response = await waitFor(() => {
      if (readdirSync(channel).some((name) => name.startsWith('control-failure-')))
        throw new Error('NATIVE_CONTROL_FAILED');
      const path = join(channel, `result-${stage}.json`);
      return existsSync(path) && JSON.parse(readFileSync(path, 'utf8'));
    }, this.deadline);
    return validateResponse(response, request, active);
  }
  async closeWindow(profile, active, owner, follower) {
    await this.stage(profile, active, 'close');
    await waitFor(
      () =>
        follower.state.closed &&
        !groupMembers(owner.child.pid).some((row) => row.pid === active.extensionHostPid),
      this.deadline,
    );
    assert.equal((await follower.completion).status, 'pass');
  }
  async quit(profile, active, owner) {
    await this.stage(profile, active, 'quit');
    await waitFor(
      () => owner.state.closed && groupMembers(owner.child.pid).length === 0,
      this.deadline,
    );
    assert.equal((await owner.completion).status, 'pass');
  }
  async cleanup() {
    let forced = false;
    const leftovers = [];
    for (const host of this.hosts) {
      if (!host.state.closed) {
        forced = true;
        await host.terminate();
      }
      const state = await host.completion;
      if (!state.cleanup.confirmedClosed || !state.cleanup.markerValid)
        leftovers.push(host.profileRecord.directory);
    }
    if (!leftovers.length) {
      try {
        const verifyDirectory = (path, identity) => {
          const current = lstatSync(path);
          assert.ok(current.isDirectory() && !current.isSymbolicLink());
          assert.equal(current.uid, process.getuid());
          assert.equal(current.ino, identity.ino);
          assert.equal(current.dev, identity.dev);
          assert.equal(current.mode & 0o777, 0o700);
        };
        verifyDirectory(this.temporary, this.temporaryIdentity);
        assert.deepEqual(
          JSON.parse(readFileSync(join(this.temporary, '.owner.json'))),
          this.marker,
        );
        for (const profile of this.profiles) {
          verifyDirectory(profile.directory, profile.identity);
          assert.deepEqual(
            JSON.parse(readFileSync(join(profile.directory, '.owner.json'))),
            this.marker,
          );
          assert.ok(
            this.hosts
              .filter((host) => host.profileRecord === profile)
              .every((host) => groupMembers(host.child.pid).length === 0),
          );
        }
        rmSync(this.temporary, { recursive: true });
      } catch {
        leftovers.push(this.temporary);
      }
    } else leftovers.push(this.temporary);
    return { forced, leftovers: [...new Set(leftovers)] };
  }
}
