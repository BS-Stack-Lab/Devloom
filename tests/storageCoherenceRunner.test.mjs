import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  realpathSync,
  chmodSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { launchOwned, probeProcess, groupMembers } from '../scripts/localGitSession.mjs';
import {
  validateResponse,
  assertSecretFree,
  waitFor,
  StorageSession,
} from '../scripts/storageCoherenceSession.mjs';

const require = createRequire(import.meta.url);
function controlValidator(name = 'storageCoherenceFixture', sandbox = {}) {
  const exports = {};
  runInNewContext(readFileSync(new URL(`../dist/tests/${name}.js`, import.meta.url), 'utf8'), {
    exports,
    process,
    require: (id) => (id === 'vscode' ? {} : id === './storageCoherenceCases' ? {} : require(id)),
    ...sandbox,
  });
  return exports;
}
const nonce = 'a'.repeat(32);
const active = {
  nonce,
  activation: 'activation',
  window: 'a',
  mainPid: 10,
  extensionHostPid: 11,
  workspace: '/fixture',
  started: Date.now() - 100,
};
const request = {
  nonce,
  activation: 'activation',
  window: 'a',
  stage: 'stage-1',
  sequence: 1,
  action: 'read',
  generation: 0,
  deleted: true,
};

test('actual compiled fixture rejects foreign, duplicate, traversal and extra-value control metadata', () => {
  const valid = controlValidator().validateControl;
  assert.equal(valid(request, nonce, 'activation', 'a', 0), true);
  for (const change of [
    { nonce: 'b'.repeat(32) },
    { activation: 'other' },
    { window: 'b' },
    { stage: '../escape' },
    { stage: 'x'.repeat(65) },
    { sequence: 0 },
    { sequence: 2 },
    { generation: -1 },
    { generation: 65 },
    { generation: 1.5 },
    { deleted: 1 },
    { action: 'unsafe' },
    { value: 'forbidden' },
  ])
    assert.equal(valid({ ...request, ...change }, nonce, 'activation', 'a', 0), false);
  assert.equal(valid(request, nonce, 'activation', 'a', 1), false);
});

test('responses require exact window, activation, stage, sequence, process and successful predicates', () => {
  const response = { ...active, ...request, observed: Date.now(), status: 'pass' };
  assert.equal(validateResponse(response, request, active), response);
  for (const change of [
    { window: 'b' },
    { activation: 'stale' },
    { stage: 'other' },
    { sequence: 2 },
    { mainPid: 12 },
    { extensionHostPid: 12 },
    { workspace: '/foreign' },
    { observed: 0 },
    { status: 'fail' },
  ])
    assert.throws(() => validateResponse({ ...response, ...change }, request, active));
});

function fixture(options = {}) {
  const parent = options.parent ?? process.env.DEVLOOM_EVIDENCE_DIR;
  assert.ok(parent, 'Set external DEVLOOM_EVIDENCE_DIR');
  const evidence = mkdtempSync(join(parent, 'storage-runner-'));
  let temporary;
  try {
    temporary = mkdtempSync('/tmp/dsc-unit-');
    options.onTemporary?.(temporary);
    temporary = realpathSync(temporary);
    const nonce = randomBytes(16).toString('hex');
    const profile = join(temporary, `p-${nonce}`);
    (options.makeProfile ?? mkdirSync)(profile, { mode: 0o700 });
    return {
      temporary,
      nonce,
      profile,
      evidence,
      fixtureRoot: temporary,
      sourceRoot: realpathSync(process.cwd()),
    };
  } catch (error) {
    if (temporary) rmSync(temporary, { recursive: true });
    rmSync(evidence, { recursive: true });
    throw error;
  }
}

function launch(f, extra = {}) {
  return launchOwned({
    ...f,
    sessionId: 'unit',
    command: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)', '--', `--user-data-dir=${f.profile}`],
    cwd: f.sourceRoot,
    env: process.env,
    timeoutMs: 10000,
    ...extra,
  });
}
function independent(f) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  const completion = new Promise((done) => child.once('close', done));
  const identity = probeProcess(child.pid);
  writeFileSync(join(f.temporary, 'sentinel'), 'independent preserved bytes', {
    flag: 'wx',
    mode: 0o600,
  });
  return { child, completion, identity };
}
async function stopKnown(child, identity, completion) {
  const observed = probeProcess(child.pid);
  for (const key of ['pid', 'uid', 'startIdentity', 'detachedPgid'])
    assert.equal(observed[key], identity[key]);
  child.kill('SIGTERM');
  await completion;
}

test('owned real child deadline reaps its group and leaves independent sentinel untouched', async () => {
  const f = fixture();
  const sentinel = independent(f);
  try {
    const host = launch(f, { timeoutMs: 150 });
    const result = await host.completion;
    assert.equal(result.timedOut, true);
    assert.equal(result.cleanup.confirmedClosed, true);
    assert.equal(result.ownership, 'captured');
    assert.equal(groupMembers(host.child.pid).length, 0);
    assert.equal(probeProcess(sentinel.child.pid).startIdentity, sentinel.identity.startIdentity);
    assert.equal(
      readFileSync(join(f.temporary, 'sentinel'), 'utf8'),
      'independent preserved bytes',
    );
    assert.ok(result.terminationAttempts.every((attempt) => attempt.target === -host.child.pid));
  } finally {
    await stopKnown(sentinel.child, sentinel.identity, sentinel.completion);
    rmSync(f.temporary, { recursive: true });
  }
});

test('authorization probe ambiguity refuses signaling and preserves owned and independent bytes', async () => {
  const f = fixture();
  const sentinel = independent(f);
  const host = launch(f, {
    authorizationProbe: () => {
      throw new Error('INJECTED_PROBE');
    },
  });
  const identity = probeProcess(host.child.pid);
  const closed = new Promise((done) => host.child.once('close', done));
  try {
    assert.equal(await host.terminate(), false);
    assert.equal(host.state.ownership, 'ambiguous');
    assert.equal(host.state.cleanup.confirmedClosed, false);
    assert.ok(host.state.cleanup.leftovers.includes(f.profile));
    assert.equal(probeProcess(host.child.pid).startIdentity, identity.startIdentity);
    assert.equal(probeProcess(sentinel.child.pid).startIdentity, sentinel.identity.startIdentity);
    assert.equal(
      readFileSync(join(f.temporary, 'sentinel'), 'utf8'),
      'independent preserved bytes',
    );
    assert.equal(
      host.state.terminationAttempts.some((attempt) => attempt.disposition === 'sent'),
      false,
    );
  } finally {
    await stopKnown(host.child, identity, closed);
    await stopKnown(sentinel.child, sentinel.identity, sentinel.completion);
    rmSync(f.temporary, { recursive: true });
  }
});

test('marker replacement refuses termination without deleting fixture data', async () => {
  const f = fixture();
  const host = launch(f);
  const identity = probeProcess(host.child.pid);
  const closed = new Promise((done) => host.child.once('close', done));
  try {
    writeFileSync(join(f.temporary, '.launch-unit.json'), '{}', { mode: 0o600 });
    assert.equal(await host.terminate(), false);
    assert.equal(host.state.cleanup.confirmedClosed, false);
    assert.equal(readFileSync(join(f.temporary, '.launch-unit.json'), 'utf8'), '{}');
  } finally {
    await stopKnown(host.child, identity, closed);
    rmSync(f.temporary, { recursive: true });
  }
});

test('privacy scanner refuses plaintext and encoded generated values without reporting them', () => {
  const f = fixture();
  try {
    const file = join(f.temporary, 'fixture');
    writeFileSync(file, JSON.stringify({ nonce: f.nonce, generation: 12 }));
    assert.equal(assertSecretFree([f.temporary], f.nonce).secretFree, true);
    const value = `storage-fixture/${f.nonce}/12/λ`;
    for (const encoded of [
      value,
      Buffer.from(value).toString('base64'),
      Buffer.from(value).toString('hex'),
      encodeURIComponent(value),
    ]) {
      writeFileSync(file, encoded);
      assert.throws(() => assertSecretFree([f.temporary], f.nonce), /^Error: PRIVACY_SCAN_FAILED$/);
    }
  } finally {
    rmSync(f.temporary, { recursive: true });
  }
});

test('bounded stage deadline fails without any match-until-success secret read', async () => {
  await assert.rejects(
    waitFor(() => false, performance.now() + 10),
    /STORAGE_STAGE_DEADLINE/,
  );
  assert.throws(() => new StorageSession(process.cwd()), /EXTERNAL_EVIDENCE_REQUIRED/);
});

test('actual compiled control reader refuses oversized, symlinked and nonprivate requests', () => {
  const f = fixture();
  const path = join(f.temporary, 'request.json');
  try {
    const readControl = controlValidator().readControl;
    writeFileSync(path, JSON.stringify(request), { mode: 0o600 });
    assert.equal(readControl(path).nonce, request.nonce);
    writeFileSync(path, 'x'.repeat(2049));
    assert.throws(() => readControl(path), /UNSAFE_CONTROL/);
    writeFileSync(path, JSON.stringify(request));
    chmodSync(path, 0o644);
    assert.throws(() => readControl(path), /UNSAFE_CONTROL/);
    chmodSync(path, 0o600);
    const alias = join(f.temporary, 'alias.json');
    symlinkSync(path, alias);
    assert.throws(() => readControl(alias));
  } finally {
    rmSync(f.temporary, { recursive: true });
  }
});

test('stage duration and compiled foreign-event deadline ignore isolated forward/back wall-clock jumps', async () => {
  const source = readFileSync(
    new URL('../scripts/storageCoherenceSession.mjs', import.meta.url),
    'utf8',
  );
  const begin = source.indexOf('export async function waitFor(');
  const end = source.indexOf('\nexport function validateResponse', begin);
  assert.ok(begin > 0 && end > begin);
  for (const jump of [-3600000, 3600000]) {
    let monotonic = 0,
      wall = 0,
      timers = 0,
      observations = 0;
    const sandbox = {
      performance: { now: () => monotonic },
      Date: { now: () => wall },
      setTimeout: (done, delay) => {
        if (++timers > 8) throw new Error('ISOLATED_CLOCK_TEST_BOUND');
        monotonic += delay;
        wall += jump;
        done();
      },
    };
    const actualWaitFor = runInNewContext(
      `${source.slice(begin, end).replace('export ', '')}\nwaitFor`,
      sandbox,
    );
    await assert.rejects(
      actualWaitFor(() => {
        observations++;
        return false;
      }, 100),
      /STORAGE_STAGE_DEADLINE/,
    );
    assert.equal(observations, 4);
    assert.equal(timers, 4);
    assert.equal(monotonic, 100);
    monotonic = 0;
    wall = 0;
    timers = 0;
    const cases = controlValidator('storageCoherenceCases', {
      Date: sandbox.Date,
      require: (id) =>
        id === 'node:perf_hooks' ? { performance: sandbox.performance } : require(id),
      setTimeout: (done, delay) => {
        assert.equal(delay, 25);
        if (++timers > 8) throw new Error('ISOLATED_CLOCK_TEST_BOUND');
        monotonic += 10000;
        wall += jump;
        done();
      },
    });
    let reads = 0;
    const instance = new cases.StorageCases(
      {
        onDidChange: () => ({ dispose() {} }),
        get: () => {
          reads++;
        },
      },
      nonce,
    );
    await assert.rejects(instance.foreign(), /FOREIGN_EVENT_DEADLINE/);
    assert.equal(timers, 4);
    assert.equal(reads, 0);
    instance.dispose();
  }
});

test('fixture construction allocates evidence first and cleans only its captured fresh temporary on failure', () => {
  const captured = [];
  assert.throws(
    () =>
      fixture({
        makeProfile: () => {
          throw new Error('INJECTED_PROFILE_CONSTRUCTION');
        },
        onTemporary: (path) => captured.push(realpathSync(path)),
      }),
    /INJECTED_PROFILE_CONSTRUCTION/,
  );
  assert.equal(captured.length, 1);
  assert.equal(existsSync(captured[0]), false);
  let allocated = false;
  assert.throws(
    () =>
      fixture({
        parent: join(
          process.env.DEVLOOM_EVIDENCE_DIR,
          `missing-${randomBytes(16).toString('hex')}`,
        ),
        onTemporary: () => {
          allocated = true;
        },
      }),
    /ENOENT/,
  );
  assert.equal(allocated, false);
});

test('owned Node argv capture binds normal windows and every installer CLI to isolated per-profile shared data', async () => {
  const session = new StorageSession(process.env.DEVLOOM_EVIDENCE_DIR);
  const entry = join(session.temporary, 'argv-installer.cjs');
  const capture = join(session.evidence, 'captured-argv.jsonl');
  writeFileSync(
    entry,
    `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (process.env.ELECTRON_RUN_AS_NODE === '1') assert.equal(args[0], '.');
const argument = name => args.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
const userData = argument('--user-data-dir');
const extensions = argument('--extensions-dir');
const sharedData = argument('--shared-data-dir');
assert.equal(sharedData, path.join(path.dirname(userData), 'shared'));
assert.equal(fs.lstatSync(sharedData).mode & 0o777, 0o700);
assert.equal(JSON.parse(fs.readFileSync(path.join(sharedData, '.owner.json'))).nonce, process.env.STORAGE_ARGV_NONCE);
fs.appendFileSync(process.env.STORAGE_ARGV_CAPTURE, JSON.stringify({ args, userData, sharedData, cli: process.env.ELECTRON_RUN_AS_NODE === '1' }) + '\\n', { mode: 0o600 });
const archive = argument('--install-extension');
const id = 'devloom.storage-coherence-fixture';
const location = path.join(extensions, id + '-1.0.0');
if (archive) {
  fs.cpSync(path.join(path.dirname(archive), 'extension'), location, { recursive: true });
  fs.writeFileSync(path.join(extensions, 'extensions.json'), JSON.stringify([{ identifier: { id }, version: '1.0.0' }]));
}
if (args.includes('--list-extensions')) process.stdout.write(id + '@1.0.0\\n');
if (argument('--locate-extension')) process.stdout.write(location + '\\n');
`,
    { flag: 'wx', mode: 0o600 },
  );
  session.runtime = {
    ...session.runtime,
    executable: process.execPath,
    guiExecutable: process.execPath,
    entry,
  };
  session.env.STORAGE_ARGV_CAPTURE = capture;
  session.env.STORAGE_ARGV_NONCE = session.nonce;
  try {
    const primary = await session.profile('primary-argv', ['a', 'b']);
    const independent = await session.profile('independent-argv', ['d']);
    for (const [profile, window] of [
      [primary, 'a'],
      [primary, 'b'],
      [independent, 'd'],
    ]) {
      const host = session.launch(profile, window, [entry]);
      assert.equal((await host.completion).status, 'pass');
      assert.ok(
        host.invocation.args.split(/\s+/).includes(`--shared-data-dir=${profile.sharedData}`),
      );
    }
    const beforeMalformed = { counter: session.counter, hosts: session.hosts.length };
    assert.throws(
      () => session.launch(primary, null, [entry, '--list-extensions'], true),
      /MISSING_NATIVE_CLI_APP_PATH/,
    );
    assert.throws(
      () => session.launch(primary, null, [entry, '.'], true),
      /INVALID_NATIVE_CLI_ACTION/,
    );
    assert.throws(
      () => session.launch(primary, null, [entry, '.', '--install-extension='], true),
      /INVALID_NATIVE_CLI_ACTION/,
    );
    assert.deepEqual({ counter: session.counter, hosts: session.hosts.length }, beforeMalformed);
    const cli = session.launch(primary, null, [entry, '.', '--list-extensions'], true);
    assert.equal((await cli.completion).status, 'pass');
    const invocations = readFileSync(capture, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(invocations.length, 10);
    assert.equal(invocations.filter((value) => value.cli).length, 7);
    const windows = invocations.filter((value) => !value.cli);
    assert.equal(windows.length, 3);
    assert.equal(windows[0].sharedData, windows[1].sharedData);
    assert.notEqual(windows[0].sharedData, windows[2].sharedData);
    for (const invocation of invocations) {
      if (invocation.cli) assert.equal(invocation.args[0], '.');
      assert.equal(invocation.sharedData, join(invocation.userData, '..', 'shared'));
      assert.equal(
        invocation.args.filter((value) => value.startsWith('--shared-data-dir=')).length,
        1,
      );
    }
  } finally {
    const cleanup = await session.cleanup();
    assert.deepEqual(cleanup, { forced: false, leftovers: [] });
  }
});

test('actual pinned compiled dev CLI parser preserves installer commands and private roots only with app placeholder', () => {
  const module = new URL(
    '../vendor/code-oss/out/vs/platform/environment/node/argvHelper.js',
    import.meta.url,
  ).href;
  const childSource = `
import { parseCLIProcessArgv } from ${JSON.stringify(module)};
const common = ['--user-data-dir=/private/tmp/parser-only-user', '--extensions-dir=/private/tmp/parser-only-extensions', '--shared-data-dir=/private/tmp/parser-only-shared'];
const commands = [['--list-extensions'], ['--install-extension=/private/tmp/parser-only.vsix'], ['--locate-extension=devloom.storage-coherence-fixture']];
const rows = commands.map(command => ({ positive: parseCLIProcessArgv(['owned-node', 'out/cli.js', '.', ...common, ...command]), missing: parseCLIProcessArgv(['owned-node', 'out/cli.js', ...common, ...command]) }));
process.stdout.write(JSON.stringify(rows));
`;
  const rows = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', childSource], {
      env: { ...process.env, VSCODE_DEV: '1' },
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 65536,
    }),
  );
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.positive['user-data-dir'], '/private/tmp/parser-only-user');
    assert.equal(row.positive['extensions-dir'], '/private/tmp/parser-only-extensions');
    assert.equal(row.positive['shared-data-dir'], '/private/tmp/parser-only-shared');
    assert.deepEqual(row.positive._, []);
    assert.equal(row.missing['user-data-dir'], undefined);
    assert.equal(row.missing['extensions-dir'], undefined);
    assert.equal(row.missing['shared-data-dir'], undefined);
    assert.equal(row.missing['list-extensions'], false);
    assert.equal(row.missing['install-extension'], undefined);
    assert.equal(row.missing['locate-extension'], undefined);
  }
  assert.equal(rows[0].positive['list-extensions'], true);
  assert.deepEqual(rows[1].positive['install-extension'], ['/private/tmp/parser-only.vsix']);
  assert.deepEqual(rows[2].positive['locate-extension'], ['devloom.storage-coherence-fixture']);
});
