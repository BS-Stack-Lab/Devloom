import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
function controlValidator() {
  const exports = {};
  runInNewContext(
    readFileSync(new URL('../dist/tests/storageCoherenceFixture.js', import.meta.url), 'utf8'),
    {
      exports,
      process,
      require: (id) => (id === 'vscode' ? {} : id === './storageCoherenceCases' ? {} : require(id)),
    },
  );
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

function fixture() {
  const parent = process.env.DEVLOOM_EVIDENCE_DIR;
  assert.ok(parent, 'Set external DEVLOOM_EVIDENCE_DIR');
  const temporary = realpathSync(mkdtempSync('/tmp/dsc-unit-'));
  const nonce = randomBytes(16).toString('hex');
  const profile = join(temporary, `p-${nonce}`);
  mkdirSync(profile, { mode: 0o700 });
  const evidence = mkdtempSync(join(parent, 'storage-runner-'));
  return {
    temporary,
    nonce,
    profile,
    evidence,
    fixtureRoot: temporary,
    sourceRoot: realpathSync(process.cwd()),
  };
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
    waitFor(() => false, Date.now() + 10),
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
