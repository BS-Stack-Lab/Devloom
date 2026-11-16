import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { root } from '../scripts/upstream.mjs';
import { privateFile } from '../scripts/transportCredentials.mjs';
import { publishCaseEvidence } from '../scripts/runGitTransports.mjs';
import { waitFor, processTree } from '../scripts/commitStateUI.mjs';
import {
  TransportSession,
  boundedHostLog,
  cloneTargetInventory,
  captureLaunchIdentity,
} from '../scripts/transportSession.mjs';

let directory;
const nonce = randomBytes(16).toString('hex');
const secret = {
  username: randomBytes(16).toString('hex'),
  password: randomBytes(32).toString('hex'),
};
secret.secrets = [secret.username, secret.password];
before(() => {
  const parent = process.env.DEVLOOM_EVIDENCE_DIR;
  assert.ok(parent && isAbsolute(parent), 'An absolute external evidence parent is required');
  const canonical = realpathSync(parent);
  const source = realpathSync(root);
  assert.ok(canonical !== source && !canonical.startsWith(`${source}/`));
  directory = mkdtempSync(join(canonical, 'transport-lifecycle-units-'));
  chmodSync(directory, 0o700);
});

test('real owned stdout and stderr overflow after activation is capped and stops once', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const ready = join(directory, `log-ready-${stream}`);
    const owner = Object.create(TransportSession.prototype);
    const host = (owner.host = { closed: false, captured: new Set() });
    const source = `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready',{mode:384});process.stdin.once('data',()=>{const b=Buffer.alloc(65536,65);for(let i=0;i<80;i++)process.${stream}.write(b);setInterval(()=>{},1000)});`;
    host.child = spawn(process.execPath, ['-e', source], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    host.captured.add(host.child.pid);
    captureLaunchIdentity(host);
    let failures = 0;
    const file = join(directory, `bounded-${stream}.log`);
    const capture = boundedHostLog(host, file, () => {
      failures++;
      void owner.stopOwnedHost().catch(() => {});
    });
    for (const output of [host.child.stdout, host.child.stderr]) output.on('data', capture.accept);
    host.child.once('close', () => {
      host.closed = true;
      capture.close();
    });
    try {
      await waitFor('owned fake host activation', () => existsSync(ready), 3000);
      owner.active = { extensionHostPid: host.child.pid };
      assert.equal(host.error, undefined);
      host.child.stdin.write('emit only after activation\n');
      await waitFor('bounded post-activation failure', () => host.error, 5000);
      await assert.rejects(owner.stage('read'), /Application output limit exceeded/);
      const stopped = await owner.stopOwnedHost();
      assert.deepEqual(stopped, { processesClosed: true, forced: true }, host.stopError);
      assert.equal(failures, 1);
      assert.equal(capture.statistics().retainedBytes, 4 * 1024 * 1024);
      assert.equal(lstatSync(file).size, 4 * 1024 * 1024);
      assert.equal(Buffer.byteLength(host.output), 4 * 1024 * 1024);
      assert.equal(capture.statistics().tailBytes, 65536);
      capture.accept(Buffer.from('ignored after the once-only failure'));
      assert.equal(failures, 1);
      assert.equal(capture.statistics().closed, true);
      assert.equal(
        processTree().some((item) => item.group === host.child.pid),
        false,
      );
    } finally {
      await owner.stopOwnedHost();
      capture.close();
    }
  }
});
test('owned stop refuses changed or missing launch identity without signalling the child', async () => {
  const ready = join(directory, 'identity-ready');
  const owner = Object.create(TransportSession.prototype);
  const host = (owner.host = { closed: false, captured: new Set() });
  host.child = spawn(
    process.execPath,
    [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready',{mode:384});setInterval(()=>{},1000)`,
    ],
    { detached: true, stdio: 'ignore' },
  );
  host.captured.add(host.child.pid);
  host.child.once('close', () => {
    host.closed = true;
  });
  let original;
  try {
    await waitFor('owned identity fixture ready', () => existsSync(ready), 3000);
    original = captureLaunchIdentity(host);
    host.identities.set(original.pid, { ...original, start: 'wrong start identity' });
    assert.deepEqual(await owner.stopOwnedHost(), { processesClosed: false, forced: false });
    assert.doesNotThrow(() => process.kill(original.pid, 0));
    const unknown = Object.create(TransportSession.prototype);
    unknown.host = { child: host.child, closed: false, captured: new Set([original.pid]) };
    assert.deepEqual(await unknown.stopOwnedHost(), { processesClosed: false, forced: false });
    assert.doesNotThrow(() => process.kill(original.pid, 0));
  } finally {
    if (!host.closed) {
      const proof = captureLaunchIdentity({ child: host.child });
      if (original) assert.deepEqual(proof, original);
      const closed = new Promise((resolve) => host.child.once('close', resolve));
      process.kill(-proof.pid, 'SIGTERM');
      await closed;
    }
  }
});
test('overflow diagnostic tail preserves the actual last bytes within the file cap', () => {
  const host = {};
  let failures = 0;
  const path = join(directory, 'bounded-tail.log');
  const capture = boundedHostLog(host, path, () => {
    failures++;
  });
  try {
    capture.accept(Buffer.alloc(4 * 1024 * 1024 - 5, 65));
    capture.accept(Buffer.from('0123456789'));
    const expected = 'A'.repeat(65536 - 10) + '0123456789';
    assert.equal(host.output.slice(-65536), expected);
    assert.equal(readFileSync(path).subarray(-65536).toString(), expected);
    assert.equal(lstatSync(path).size, 4 * 1024 * 1024);
    capture.accept(Buffer.from('must not grow or notify again'));
    assert.equal(failures, 1);
  } finally {
    capture.close();
  }
});
test('privacy failure cleans keys only with complete app/server and private-root proof', () => {
  for (const state of [
    'closed',
    'forced-closed',
    'unknown-app',
    'leftovers',
    'unknown-server',
    'pending',
  ]) {
    const nonce = randomBytes(16).toString('hex');
    const root = join(directory, `publication-${nonce}`);
    const keyRoot = join(root, `secrets-${nonce}`);
    const exported = join(root, 'public');
    for (const path of [root, keyRoot, exported]) mkdirSync(path, { mode: 0o700 });
    privateFile(join(keyRoot, 'credential'), secret.password);
    privateFile(join(exported, 'leak'), secret.username);
    const cleanup = {
      processesClosed: state !== 'unknown-app',
      forced: state === 'forced-closed',
      leftovers: state === 'leftovers' ? ['unproven child'] : [],
    };
    try {
      assert.throws(
        () =>
          publishCaseEvidence({
            record: { nonce, sessionEvidence: exported },
            directory: root,
            secret: { directory: keyRoot, secrets: secret.secrets },
            appCleanup: cleanup,
            serverClosed: state !== 'unknown-server',
            preserve: state === 'pending',
          }),
        (error) => {
          assert.equal(error.code, 'PUBLIC_EVIDENCE_SENSITIVE');
          for (const value of secret.secrets) assert.equal(String(error).includes(value), false);
          return true;
        },
      );
      assert.equal(existsSync(keyRoot), !['closed', 'forced-closed'].includes(state));
      assert.equal(existsSync(join(root, 'case-result.json')), false);
    } finally {
      rmSync(root, { recursive: true });
    }
  }
  const nonce = randomBytes(16).toString('hex');
  const root = join(directory, `unsafe-publication-${nonce}`);
  const foreign = join(directory, `foreign-private-${nonce}`);
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(foreign, { mode: 0o700 });
  privateFile(join(foreign, 'untouched'), 'foreign fixture bytes');
  const keyRoot = join(root, `secrets-${nonce}`);
  symlinkSync(foreign, keyRoot);
  try {
    assert.throws(
      () =>
        publishCaseEvidence({
          record: { nonce },
          directory: root,
          secret: { directory: keyRoot, secrets: [] },
          appCleanup: { processesClosed: true, leftovers: [] },
          serverClosed: true,
          preserve: false,
        }),
      (error) => error.code === 'SECRET_ROOT_UNSAFE',
    );
    assert.equal(readFileSync(join(foreign, 'untouched'), 'utf8'), 'foreign fixture bytes');
    assert.equal(lstatSync(keyRoot).isSymbolicLink(), true);
  } finally {
    rmSync(root, { recursive: true });
    rmSync(foreign, { recursive: true });
  }
});
test('exact clone basename inventory detects changed bytes and replaced directory identity', () => {
  const owner = Object.create(TransportSession.prototype);
  owner.clones = join(directory, 'occupied-clones');
  mkdirSync(owner.clones, { mode: 0o700 });
  owner.nonce = nonce;
  owner.fixture = { url: `https://127.0.0.1:12345/remote-${nonce}.git` };
  const occupied = owner.occupyCloneTarget();
  assert.equal(occupied.path, join(owner.clones, `remote-${nonce}`));
  assert.deepEqual(cloneTargetInventory(occupied.path), occupied.before);
  writeFileSync(join(occupied.path, 'existing.txt'), 'changed bytes');
  assert.notDeepEqual(cloneTargetInventory(occupied.path), occupied.before);
  renameSync(occupied.path, `${occupied.path}-original`);
  mkdirSync(occupied.path, { mode: 0o700 });
  assert.notEqual(cloneTargetInventory(occupied.path)[0].inode, occupied.before[0].inode);
});
for (const code of ['ENOENT', 'EACCES']) {
  test(`real ${code} launch failure observes close and preserves unknown private ownership`, async (t) => {
    const caseNonce = randomBytes(16).toString('hex');
    const caseRoot = join(directory, `launch-${code}-${caseNonce}`);
    const keyRoot = join(caseRoot, `secrets-${caseNonce}`);
    const owner = Object.create(TransportSession.prototype);
    owner.evidence = join(caseRoot, 'public');
    owner.temporary = join(caseRoot, 'temporary');
    owner.profile = { id: caseNonce, path: join(caseRoot, 'profile') };
    owner.workspace = join(owner.temporary, 'workspace');
    owner.env = {};
    for (const path of [
      caseRoot,
      keyRoot,
      owner.evidence,
      owner.temporary,
      owner.profile.path,
      owner.workspace,
    ])
      mkdirSync(path, { mode: 0o700 });
    const key = join(keyRoot, 'credential');
    privateFile(key, secret.password);
    const sentinel = join(owner.temporary, 'untouched');
    privateFile(sentinel, caseNonce);
    const command = join(caseRoot, `command-${caseNonce}`);
    if (code === 'EACCES') privateFile(command, secret.username);
    const signals = [];
    t.mock.method(process, 'kill', (...args) => {
      signals.push(args);
      throw new Error('Unexpected signal during failed launch');
    });
    let actualError;
    let closes = 0;
    const started = Date.now();
    let rejected = false;
    try {
      await owner.launch(false, (_command, _args, options) => {
        const child = spawn(command, [], options);
        child.once('error', (error) => {
          actualError = error.code;
        });
        child.once('close', () => closes++);
        return child;
      });
    } catch (error) {
      rejected = error instanceof Error && error.message === `Application launch failed (${code})`;
    }
    assert.ok(rejected, 'Failed launch must reject with the fixed classification');
    assert.ok(Date.now() - started < 3000);
    assert.equal(actualError, code);
    assert.equal(owner.host.launchErrorCode, code);
    assert.equal(owner.host.child.pid, undefined);
    assert.deepEqual([...owner.host.captured], []);
    assert.equal(owner.host.launchIdentity, undefined);
    assert.equal(owner.host.closed, true);
    assert.equal(closes, 1);
    assert.equal(typeof owner.host.exit.code, 'number');
    assert.notEqual(owner.host.exit.code, 0);
    assert.equal(owner.host.exit.signal, null);
    assert.equal(existsSync(join(owner.evidence, 'application.log')), false);
    assert.deepEqual(await owner.stopOwnedHost(), { processesClosed: false, forced: false });
    const cleanup = await owner.cleanup();
    assert.deepEqual(cleanup, {
      processesClosed: false,
      forced: false,
      leftovers: [owner.profile.path, owner.temporary],
    });
    publishCaseEvidence({
      record: { nonce: caseNonce, sessionEvidence: owner.evidence, appCleanup: cleanup },
      directory: caseRoot,
      secret: { directory: keyRoot, secrets: secret.secrets },
      appCleanup: cleanup,
      serverClosed: true,
      preserve: false,
    });
    assert.ok(
      readFileSync(key, 'utf8') === secret.password,
      'Unknown application ownership must preserve the private credential',
    );
    assert.equal(readFileSync(sentinel, 'utf8'), caseNonce);
    assert.equal(existsSync(owner.profile.path), true);
    assert.deepEqual(signals, []);
    const diagnostic = JSON.stringify(owner.host.error);
    assert.ok(diagnostic.length < 100);
    for (const value of [command, ...secret.secrets])
      assert.equal(diagnostic.includes(value), false);
  });
}

test('synchronous launch throw stores only a bounded classification and retains private paths', async (t) => {
  const owner = Object.create(TransportSession.prototype);
  owner.profile = { id: nonce, path: join(directory, 'throw-profile') };
  owner.temporary = join(directory, 'throw-temporary');
  owner.workspace = join(owner.temporary, 'workspace');
  for (const path of [owner.profile.path, owner.temporary, owner.workspace])
    mkdirSync(path, { mode: 0o700 });
  const signals = [];
  t.mock.method(process, 'kill', (...args) => signals.push(args));
  let rejected = false;
  try {
    await owner.launch(false, () => {
      throw Object.assign(new Error(secret.password), { code: secret.username });
    });
  } catch (error) {
    rejected = error instanceof Error && error.message === 'Application launch failed (UNKNOWN)';
  }
  assert.ok(rejected, 'Synchronous launch failure must reject with the fixed classification');
  assert.equal(owner.host.child, undefined);
  assert.equal(owner.host.closed, false);
  assert.deepEqual([...owner.host.captured], []);
  assert.deepEqual(await owner.cleanup(), {
    processesClosed: false,
    forced: false,
    leftovers: [owner.profile.path, owner.temporary],
  });
  assert.deepEqual(signals, []);
  assert.equal(existsSync(owner.profile.path), true);
  assert.equal(existsSync(owner.temporary), true);
  for (const value of secret.secrets) assert.equal(owner.host.error.includes(value), false);
});
