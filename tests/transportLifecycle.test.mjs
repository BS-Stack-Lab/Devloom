import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { spawn } from 'node:child_process';
import childProcess from 'node:child_process';
import fileSystem from 'node:fs';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { Writable } from 'node:stream';
import { relayCgi } from '../scripts/transportCgi.mjs';
import { sshServer } from '../scripts/transportSsh.mjs';
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

const sshStartupObservations = [];
async function sshStartupFixture(t, mode) {
  const caseNonce = randomBytes(16).toString('hex');
  const fixture = join(directory, `ssh-startup-${mode}-${caseNonce}`);
  const keyRoot = join(fixture, `secrets-${caseNonce}`);
  const evidence = join(fixture, 'public');
  for (const path of [fixture, keyRoot, evidence]) mkdirSync(path, { mode: 0o700 });
  for (const name of ['client.pub', 'host.pub', 'wrong-host.pub'])
    privateFile(join(keyRoot, name), 'ssh-ed25519 synthetic-unit-only');
  privateFile(join(keyRoot, 'empty'), '');
  privateFile(join(keyRoot, 'credential'), secret.password);
  const ready = join(fixture, 'inert-child-ready');
  const trigger = join(fixture, 'inert-output-trigger');
  const original = {
    spawn: childProcess.spawn,
    execFileSync: childProcess.execFileSync,
    existsSync: fileSystem.existsSync,
    createServer: net.createServer,
    kill: process.kill,
  };
  const state = { reservations: [], signals: [], closes: 0, errors: [], spawns: 0, lsof: 0 };
  let blocker;
  if (mode === 'listen') {
    blocker = original.createServer();
    await new Promise((resolve, reject) =>
      blocker.once('error', reject).listen(0, '127.0.0.1', resolve),
    );
  }
  t.mock.method(fileSystem, 'existsSync', (path) =>
    ['/etc/zshenv', '/etc/ssh/sshrc'].includes(path) ? false : original.existsSync(path),
  );
  t.mock.method(net, 'createServer', (...args) => {
    const server = original.createServer(...args);
    state.reservations.push(server);
    if (blocker) {
      const listen = server.listen;
      t.mock.method(server, 'listen', (_port, _host, callback) =>
        listen.call(server, blocker.address().port, '127.0.0.1', callback),
      );
    }
    return server;
  });
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    if (command !== '/usr/sbin/sshd') return original.spawn(command, args, options);
    state.spawns++;
    if (mode === 'throw') throw new Error(secret.password);
    const missing = join(fixture, `command-${caseNonce}`);
    if (mode === 'EACCES') privateFile(missing, secret.username);
    state.child = ['ENOENT', 'EACCES'].includes(mode)
      ? original.spawn(missing, [], options)
      : original.spawn(
          process.execPath,
          [
            '-e',
            `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},process.argv.at(-1),{mode:384});${mode === 'overflow' ? `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(trigger)})){clearInterval(timer);const b=Buffer.alloc(65536,255);for(let i=0;i<40;i++)process.stderr.write(b)}},5);` : ''}setInterval(()=>{},1000)`,
            caseNonce,
          ],
          options,
        );
    state.child.once('error', (error) => state.errors.push(error.code));
    state.child.once('close', () => state.closes++);
    if (state.child.pid)
      state.proof = original.execFileSync(
        '/bin/ps',
        ['-p', String(state.child.pid), '-o', 'uid=,lstart=,ppid=,pgid='],
        { encoding: 'utf8', timeout: 1000 },
      );
    return state.child;
  });
  t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    if (command === '/usr/bin/dscl') return 'UserShell: /bin/zsh';
    if (command === '/usr/sbin/sshd') {
      if (mode === 'config-t' && args[0] === '-t') throw new Error(secret.password);
      if (args[0] === '-t') return '';
      if (mode === 'config-T') throw new Error(secret.password);
      const configuration = readFileSync(args[2], 'utf8');
      const port = configuration.match(/^Port (\d+)$/m)[1];
      return configuration
        .trim()
        .split('\n')
        .map((line) => {
          const split = line.indexOf(' ');
          const key = line.slice(0, split).toLowerCase();
          let value = line.slice(split + 1);
          if (key === 'listenaddress')
            value = `${mode === 'config-mismatch' ? '0.0.0.0' : value}:${port}`;
          return `${key} ${value}`;
        })
        .join('\n');
    }
    if (command === '/usr/sbin/lsof') {
      state.lsof++;
      if (!existsSync(ready)) throw new Error('Inert child readiness pending');
      state.ready = readFileSync(ready, 'utf8') === caseNonce;
      const port = args.find((arg) => arg.startsWith('-iTCP:')).slice(6);
      const pid =
        mode === 'wrong-pid' || mode === 'changed-identity' ? process.pid : state.child.pid;
      const address = mode === 'wrong-address' ? '0.0.0.0' : '127.0.0.1';
      const header = 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME';
      const row = `node ${pid} fixture 3u IPv4 0x1 0t0 TCP ${address}:${port} (LISTEN)`;
      if (mode === 'empty') return header;
      if (mode === 'headerless')
        return `node ${process.pid} fixture 4u IPv4 0x1 0t0 TCP 127.0.0.1:${port} (LISTEN)\n${row}`;
      return `${header}\n${row}${mode === 'mixed' ? `\nnode ${process.pid} fixture 4u IPv4 0x1 0t0 TCP 127.0.0.1:${port} (LISTEN)` : ''}`;
    }
    if (
      mode === 'changed-identity' &&
      state.ready &&
      command === '/bin/ps' &&
      args.includes('uid=,lstart=')
    )
      return `${process.getuid()} changed-start-identity`;
    return original.execFileSync(command, args, options);
  });
  t.mock.method(process, 'kill', (pid, signal) => {
    state.signals.push({ pid, signal });
    assert.ok(mode !== 'changed-identity', 'Unproven SSH identity must not be signalled');
    assert.ok(pid === -state.child?.pid, 'Only the captured inert group may be signalled');
    const current = original.execFileSync(
      '/bin/ps',
      ['-p', String(state.child.pid), '-o', 'uid=,lstart=,ppid=,pgid='],
      { encoding: 'utf8', timeout: 1000 },
    );
    assert.ok(current === state.proof, 'Test signal requires unchanged independent child proof');
    return original.kill(pid, signal);
  });
  syncBuiltinESMExports();
  return {
    caseNonce,
    trigger,
    fixture,
    keyRoot,
    evidence,
    state,
    async cleanup() {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      for (const server of [...state.reservations, blocker].filter(Boolean))
        if (server.listening) await new Promise((resolve) => server.close(resolve));
      if (state.child?.pid && state.closes === 0) {
        const current = original.execFileSync(
          '/bin/ps',
          ['-p', String(state.child.pid), '-o', 'uid=,lstart=,ppid=,pgid='],
          { encoding: 'utf8', timeout: 1000 },
        );
        assert.ok(current === state.proof, 'Private teardown requires unchanged owned child proof');
        original.kill(-state.child.pid, 'SIGTERM');
        await waitFor('independent inert child teardown', () => state.closes === 1, 2000);
      }
      if (state.child?.pid)
        assert.ok(
          !processTree().some((row) => row.group === state.child.pid),
          'No captured inert child group may remain after teardown',
        );
    },
  };
}

for (const mode of [
  'config-t',
  'config-T',
  'config-mismatch',
  'listen',
  'ENOENT',
  'EACCES',
  'throw',
  'wrong-pid',
  'wrong-address',
  'empty',
  'headerless',
  'mixed',
  'owned',
  'overflow',
  'changed-identity',
]) {
  test(`synthetic SSH startup ${mode} enforces actual socket and inert-child lifetime`, async (t) => {
    const fixture = await sshStartupFixture(t, mode);
    const { state } = fixture;
    const started = Date.now();
    let server;
    let rejected = false;
    let safeFailure = false;
    try {
      try {
        server = await sshServer(
          { directory: fixture.keyRoot, empty: join(fixture.keyRoot, 'empty') },
          join(fixture.fixture, 'remote.git'),
          fixture.evidence,
          fixture.caseNonce,
        );
      } catch (error) {
        rejected = true;
        safeFailure =
          error instanceof Error &&
          [
            'Native SSH startup refused',
            'Native SSH startup failed; private daemon ownership or closure unproven',
          ].includes(error.message);
      }
      assert.ok(
        rejected === !['owned', 'overflow'].includes(mode),
        'SSH startup must match the intended ownership result',
      );
      assert.ok(
        !rejected || safeFailure,
        'SSH startup failure diagnostics must remain fixed and bounded',
      );
      assert.ok(state.reservations.length === 1, 'Exactly one owned reservation must be observed');
      assert.ok(
        state.reservations.every((socket) => !socket.listening),
        'Source must close its actual reservation before returning',
      );
      const beforeSpawn = ['config-t', 'config-T', 'config-mismatch', 'listen'].includes(mode);
      assert.ok(
        state.spawns === (beforeSpawn ? 0 : 1),
        'Daemon spawn must follow validated closed reservation',
      );
      if (['ENOENT', 'EACCES'].includes(mode)) {
        assert.ok(Date.now() - started < 3000, 'No-PID failure must reject within the short bound');
        assert.ok(
          state.errors.length === 1 && state.errors[0] === mode,
          'Actual failed spawn error must be observed',
        );
        assert.ok(
          state.child.pid === undefined && state.closes === 1,
          'Actual no-PID child close must be observed',
        );
      }
      if (['owned', 'overflow'].includes(mode)) {
        assert.ok(state.ready === true, 'Real inert child must prove readiness');
        assert.ok(
          server.events.some((event) => event.kind === 'listener' && event.pid === state.child.pid),
          'Healthy listener metadata must bind the captured actual PID',
        );
        if (mode === 'overflow') {
          privateFile(fixture.trigger, 'emit');
          await waitFor('actual inert SSH stderr overflow', () => state.closes === 1, 4000);
          let refused = false;
          try {
            await server.close();
          } catch (error) {
            refused =
              error instanceof Error && error.message === 'Native SSH daemon capture failed';
          }
          assert.ok(refused, 'Overflow must remain a failed daemon capture after actual close');
          const limits = server.events.filter((event) => event.kind === 'daemon-output-limit');
          assert.ok(limits.length === 1, 'Stderr overflow must notify exactly once');
          assert.ok(
            limits[0].retainedBytes === 1024 * 1024 && limits[0].maximumBytes === 1024 * 1024,
            'Daemon output must retain only the fixed actual byte cap',
          );
          const bytes = readFileSync(join(fixture.evidence, 'ssh-daemon.log'));
          assert.ok(
            bytes.length === 1024 * 1024 && bytes.equals(Buffer.alloc(1024 * 1024, 255)),
            'Bounded daemon log must preserve exact binary bytes',
          );
        } else await server.close();
      }
      if (mode === 'changed-identity') {
        assert.ok(
          state.ready === true && state.closes === 0,
          'Unknown identity must preserve the actual live private child',
        );
        assert.ok(state.signals.length === 0, 'Unknown identity must not authorize any signal');
      } else if (state.child?.pid) {
        assert.ok(
          state.ready === true && state.closes === 1,
          'Owned startup failure or normal stop must await actual child close',
        );
        assert.ok(
          !processTree().some((row) => row.group === state.child.pid),
          'Proven owned child group must be empty',
        );
        assert.ok(
          state.signals.length === 1 && state.signals[0].signal === 'SIGTERM',
          'Only one proven owned TERM must be needed',
        );
      } else assert.ok(state.signals.length === 0, 'No observed owned child means no signal');
      assert.ok(
        readFileSync(join(fixture.keyRoot, 'credential'), 'utf8') === secret.password,
        'SSH startup never deletes private credentials on failure or uncertainty',
      );
      sshStartupObservations.push({
        mode,
        kind: 'synthetic-metadata-actual-net-and-inert-node-child-only',
        rejected,
        safeFailure,
        reservationClosedBySource: state.reservations.every((socket) => !socket.listening),
        spawns: state.spawns,
        actualChildPid: state.child?.pid ?? null,
        actualErrors: state.errors,
        closesBeforeIndependentTeardown: state.closes,
        sourceSignals: state.signals,
      });
      writeFileSync(
        join(directory, 'ssh-startup-observations.json'),
        JSON.stringify(sshStartupObservations, null, 2),
        { mode: 0o600 },
      );
    } finally {
      await fixture.cleanup();
    }
  });
}

for (const mode of ['control', 'exit-close-gap']) {
  test(`actual CGI ${mode} retains accounting until owned stdio and child close`, async (t) => {
    const caseNonce = randomBytes(16).toString('hex');
    const fixture = join(directory, `cgi-lifetime-${mode}-${caseNonce}`);
    mkdirSync(fixture, { mode: 0o700 });
    const spool = join(fixture, 'body');
    const empty = join(fixture, 'empty');
    const ready = join(fixture, 'ready');
    const exitGate = join(fixture, 'exit');
    const release = join(fixture, 'release');
    const descendantReady = join(fixture, 'descendant-ready');
    const payload = Buffer.from(`${caseNonce}:payload\n`);
    privateFile(spool, payload);
    privateFile(empty, '');
    const originalExec = childProcess.execFileSync;
    const originalRead = fileSystem.createReadStream;
    const originalAssert = assert.ok;
    const columns = 'pid=,ppid=,pgid=,uid=,lstart=,comm=';
    const parse = (text) =>
      text
        .trim()
        .split('\n')
        .map((line) => {
          const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(.{24})\s+(.+)$/);
          return (
            match && {
              pid: +match[1],
              parent: +match[2],
              group: +match[3],
              uid: +match[4],
              start: match[5],
            }
          );
        })
        .filter(Boolean);
    const snapshot = () =>
      parse(originalExec('/bin/ps', ['-axo', columns], { encoding: 'utf8', timeout: 1000 }));
    const matches = (row, proof) =>
      row &&
      proof &&
      row.pid === proof.pid &&
      row.uid === proof.uid &&
      row.group === proof.group &&
      row.start === proof.start;
    let child;
    let directProof;
    let descendantProof;
    let reader;
    let exited;
    let closed;
    let readerClosed;
    let seen = 0;
    let missing = 0;
    let missingAssertions = 0;
    let settled = false;
    let resolved = false;
    let result;
    let failureClass;
    let tracked;
    let gap;
    const events = [];
    const active = new Set();
    const token = Object.freeze({});
    const chunks = [];
    const response = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    });
    let responseStatus;
    response.writeHead = (status) => {
      responseStatus = status;
    };
    t.mock.method(fileSystem, 'createReadStream', (path, options) => {
      const stream = originalRead(path, options);
      if (path === spool) {
        reader = stream;
        stream.once('close', () => {
          readerClosed = Date.now();
        });
      }
      return stream;
    });
    t.mock.method(assert, 'ok', (value, message, ...args) => {
      if (!value && message === 'Missing live backend identity') missingAssertions++;
      return originalAssert(value, message, ...args);
    });
    t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
      const value = originalExec(command, args, options);
      if (command === '/bin/ps' && args.length === 2 && args[1] === columns) {
        const rows = parse(value);
        const direct = rows.find((row) => row.pid === child?.pid);
        const descendant = rows.find((row) => row.pid === descendantProof?.pid);
        if (
          matches(direct, directProof) &&
          (mode === 'control' || matches(descendant, descendantProof))
        )
          seen++;
        if (!direct && matches(descendant, descendantProof)) missing++;
      }
      return value;
    });
    syncBuiltinESMExports();
    try {
      const helper = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(descendantReady)},JSON.stringify({nonce:process.argv.at(-1),pid:process.pid}),{mode:384});const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.exit(0)}},5);`;
      const program = `const fs=require('node:fs');${mode === 'exit-close-gap' ? `const descendant=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(helper)},process.argv.at(-1)],{stdio:['ignore',process.stdout,process.stderr]});descendant.once('error',()=>process.exit(85));` : ''}let bytes=0;process.stdin.on('data',b=>bytes+=b.length);process.stdin.on('end',()=>{process.stdout.write('Content-Type: application/octet-stream\\r\\n\\r\\nowned-body',()=>{fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({nonce:process.argv.at(-1),pid:process.pid,bytes}),{mode:384});const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(exitGate)})){clearInterval(timer);process.exit(0)}},5);});});`;
      tracked = relayCgi({
        request: { method: 'POST', contentType: 'application/x-git-receive-pack-request' },
        response,
        remote: join(fixture, 'remote.git'),
        selected: {
          path: `/remote-${caseNonce}.git/git-receive-pack`,
          service: 'git-receive-pack',
        },
        spool,
        bytes: payload.length,
        emptyGlobal: empty,
        event: (event) => events.push(event),
        control: () => 'release',
        accounting: { active, token },
        backend: (env) => {
          child = spawn(process.execPath, ['-e', program, caseNonce], {
            env,
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          child.once('exit', (code, signal) => {
            exited = { at: Date.now(), code, signal };
          });
          child.once('close', (code, signal) => {
            closed = { at: Date.now(), code, signal };
          });
          directProof = snapshot().find((row) => row.pid === child.pid);
          assert.ok(
            directProof?.parent === process.pid &&
              directProof.uid === process.getuid() &&
              directProof.group === child.pid,
            'Actual backend must have stable owned launch identity',
          );
          const argv = originalExec('/bin/ps', ['-p', String(child.pid), '-o', 'args='], {
            encoding: 'utf8',
            timeout: 1000,
          });
          assert.ok(argv.includes(caseNonce), 'Live backend arguments must bind the nonce');
          return child;
        },
      }).then(
        (value) => {
          resolved = true;
          result = value;
          settled = true;
        },
        (error) => {
          failureClass = ['Backend stream failed', 'Missing live backend identity'].includes(
            error.message,
          )
            ? error.message
            : 'OTHER_RELAY_FAILURE';
          settled = true;
        },
      );
      await waitFor('actual CGI body and nonce readiness', () => existsSync(ready), 4000);
      const report = JSON.parse(readFileSync(ready, 'utf8'));
      assert.ok(
        report.nonce === caseNonce && report.pid === child.pid && report.bytes === payload.length,
        'Actual backend must consume the complete owned body',
      );
      if (mode === 'exit-close-gap') {
        await waitFor('actual held descendant readiness', () => existsSync(descendantReady), 4000);
        const helperReport = JSON.parse(readFileSync(descendantReady, 'utf8'));
        descendantProof = snapshot().find((row) => row.pid === helperReport.pid);
        assert.ok(
          helperReport.nonce === caseNonce &&
            descendantProof?.parent === child.pid &&
            descendantProof.uid === process.getuid() &&
            descendantProof.group === child.pid,
          'Actual live descendant must have nonce-bound initial ancestry',
        );
      }
      await waitFor('source observes owned backend and required descendant', () => seen >= 2, 4000);
      privateFile(exitGate, 'exit');
      await waitFor('actual direct child exit', () => exited, 4000);
      if (mode === 'exit-close-gap') {
        await waitFor(
          'source observes missing direct PID with held owned stdio',
          () => missing > 0,
          4000,
        );
        const rows = snapshot();
        gap = {
          directAbsent: !rows.some((row) => row.pid === child.pid),
          descendantPresent: matches(
            rows.find((row) => row.pid === descendantProof.pid),
            descendantProof,
          ),
          closeObserved: Boolean(closed),
          active: active.size,
          relaySettled: settled,
          spoolPresent: existsSync(spool),
        };
        assert.ok(
          gap.directAbsent && gap.descendantPresent && !gap.closeObserved,
          'Actual exit must precede stdio close while the captured descendant remains',
        );
        assert.ok(
          gap.active === 1 && !gap.relaySettled && gap.spoolPresent,
          'Exit alone must not release accounting, settle the relay or remove the spool',
        );
        privateFile(release, 'release');
      }
      await waitFor('actual CGI relay settles after full close', () => settled, 5000);
      await tracked;
      const finalRows = snapshot();
      const observation = {
        mode,
        kind: 'actual-node-child-and-reader-synthetic-writable-response',
        directProof,
        descendantProof,
        exited,
        closed,
        readerClosed,
        sourceOwnedSnapshots: seen,
        sourceMissingDirectSnapshots: missing,
        sourceMissingIdentityAssertions: missingAssertions,
        gap,
        resolved,
        failureClass,
        activeAfter: active.size,
        inputBytes: report.bytes,
        responseBytes: Buffer.concat(chunks).length,
        ownedGroupEmpty: !finalRows.some((row) => row.group === child.pid),
        spoolPresent: existsSync(spool),
      };
      privateFile(join(fixture, 'observation.json'), JSON.stringify(observation, null, 2));
      assert.ok(
        exited?.code === 0 && closed?.code === 0 && closed.at >= exited.at,
        'Actual backend must exit successfully and subsequently close',
      );
      assert.ok(
        reader?.closed && readerClosed && observation.ownedGroupEmpty,
        'Actual reader and entire owned group must close',
      );
      assert.ok(
        resolved,
        'Healthy owned CGI lifetime must resolve after exit and actual stdio close',
      );
      assert.ok(
        active.size === 0 && result?.inputBytes === payload.length && result.code === 0,
        'Only fully closed successful relay may release active accounting',
      );
      assert.ok(
        responseStatus === 200 && Buffer.concat(chunks).equals(Buffer.from('owned-body')),
        'Actual CGI bytes must reach the synthetic writable without loss',
      );
      assert.ok(
        missingAssertions === 0,
        'Previously captured direct exit must not become an identity failure before close',
      );
      assert.ok(existsSync(spool), 'CGI itself must never delete the caller-owned spool');
    } finally {
      privateFile(
        join(fixture, 'finally-observation.json'),
        JSON.stringify(
          {
            mode,
            kind: 'actual-resource-observation-with-fixture-only-initial-identity-proof',
            directProof,
            descendantProof,
            exited,
            closed,
            readerClosed,
            gap,
            sourceOwnedSnapshots: seen,
            sourceMissingDirectSnapshots: missing,
            sourceMissingIdentityAssertions: missingAssertions,
            sourceEventKinds: events.map((event) => event.kind),
            resolved,
            settled,
            failureClass,
            activeBeforeIndependentTeardown: active.size,
            spoolPresent: existsSync(spool),
          },
          null,
          2,
        ),
      );
      for (const path of [exitGate, release]) if (!existsSync(path)) privateFile(path, 'release');
      if (child && !closed) {
        try {
          await waitFor('owned CGI natural teardown', () => closed, 3000);
        } catch {
          const group = snapshot().filter((row) => row.group === child.pid);
          assert.ok(
            group.every((row) => matches(row, directProof) || matches(row, descendantProof)),
            'Fallback teardown requires unchanged captured group identities',
          );
          if (group.length) process.kill(-child.pid, 'SIGTERM');
          await waitFor('proven CGI fallback close', () => closed, 2000);
        }
      }
      if (tracked) {
        await waitFor('owned CGI relay teardown', () => settled, 5000);
        await tracked;
      }
      response.destroy();
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
}
