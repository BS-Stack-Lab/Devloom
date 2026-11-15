import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  CDP,
  discoverEndpoint,
  loopback,
  verifyListeners,
  selectTarget,
  waitFor,
} from '../scripts/commitStateUI.mjs';
import { Session, validateResponse } from '../scripts/commitStateSession.mjs';
import { verifyOwnedPath } from '../dist/tests/commitStateFixtures.js';

const endpoint = 'ws://127.0.0.1:23456/devtools/browser/abcd-1234';
const log = `DevTools listening on ${endpoint}\n`;
function temporary(run) {
  const path = mkdtempSync('/tmp/dcs-unit-');
  try {
    return run(path);
  } finally {
    rmSync(path, { recursive: true });
  }
}
test('current launch requires a unique valid literal-loopback browser endpoint', () => {
  assert.equal(discoverEndpoint(log, undefined, Date.now()), endpoint);
  assert.equal(discoverEndpoint(log + log, undefined, Date.now()), endpoint);
  for (const value of [
    '',
    'DevTools listening on rubbish\n',
    `${log}DevTools listening on ws://127.0.0.1:12345/devtools/browser/other\n`,
    'DevTools listening on ws://localhost:23456/devtools/browser/abcd\n',
    'DevTools listening on ws://0.0.0.0:23456/devtools/browser/abcd\n',
    'DevTools listening on ws://127.0.0.1:23456/devtools/page/abcd\n',
  ])
    assert.throws(() => discoverEndpoint(value, undefined, Date.now()));
});
test('optional debug file is absent or current matching regular owned data', () =>
  temporary((path) => {
    const file = join(path, 'DevToolsActivePort');
    const launched = Date.now() - 2000;
    assert.equal(discoverEndpoint(log, file, launched), endpoint);
    writeFileSync(file, '23456\n/devtools/browser/abcd-1234\n', { mode: 0o600 });
    assert.equal(discoverEndpoint(log, file, launched), endpoint);
    writeFileSync(file, '23457\n/devtools/browser/abcd-1234\n');
    assert.throws(() => discoverEndpoint(log, file, launched));
    writeFileSync(file, '23456\n/devtools/browser/conflict\n');
    assert.throws(() => discoverEndpoint(log, file, launched));
    writeFileSync(file, '23456\n/devtools/browser/abcd-1234\n');
    utimesSync(file, 1, 1);
    assert.throws(() => discoverEndpoint(log, file, launched));
    utimesSync(file, new Date(), new Date());
    chmodSync(file, 0o666);
    assert.throws(() => discoverEndpoint(log, file, launched));
    chmodSync(file, 0o600);
    symlinkSync(file, join(path, 'alias'));
    assert.throws(() => discoverEndpoint(log, join(path, 'alias'), launched));
  }));
test('listener proof rejects wildcard, foreign pid, wrong group and uncertain ownership', () => {
  assert.deepEqual(
    verifyListeners('p123\nn127.0.0.1:23456\n', 123, 120, () => 120),
    [{ pid: 123, address: '127.0.0.1:23456' }],
  );
  assert.equal(verifyListeners('p123\nn[::1]:23456\n', 123, 120, () => 120).length, 1);
  for (const records of [
    '',
    'p456\nn127.0.0.1:23456',
    'p123\nn*:23456',
    'p123\nn192.168.1.2:23456',
    'n127.0.0.1:23456',
  ])
    assert.throws(() => verifyListeners(records, 123, 120, () => 120));
  assert.throws(() => verifyListeners('p123\nn127.0.0.1:23456', 123, 120, () => 999));
  assert.throws(() =>
    verifyListeners('p123\nn127.0.0.1:23456', 123, 120, () => {
      throw new Error('ps missing');
    }),
  );
});
test('response binding rejects stale nonce activation sequence pid time and profile', () => {
  const request = {
    nonce: 'nonce',
    session: 'session',
    activation: 'activation',
    stage: 'stage',
    sequence: 7,
    action: 'read',
  };
  const active = {
    mainPid: 123,
    extensionHostPid: 456,
    workspace: '/tmp/workspace',
    profile: '/tmp/profile',
    started: Date.now() - 1000,
  };
  const response = {
    ...request,
    ...active,
    status: 'pass',
    observed: Date.now(),
    storageUri: '/tmp/profile/u/storage',
    globalStorageUri: '/tmp/profile/u/global',
  };
  const profile = { userData: '/tmp/profile/u' };
  assert.equal(validateResponse(response, request, active, profile), response);
  for (const key of [
    'nonce',
    'session',
    'activation',
    'stage',
    'sequence',
    'action',
    'mainPid',
    'extensionHostPid',
    'workspace',
    'profile',
    'observed',
    'storageUri',
    'globalStorageUri',
    'status',
  ])
    assert.throws(() =>
      validateResponse(
        { ...response, [key]: key === 'observed' ? 0 : 'wrong' },
        request,
        active,
        profile,
      ),
    );
});
test('ownership verification preserves ambiguous paths and markers', () =>
  temporary((path) => {
    const owned = join(path, 'owned');
    mkdirSync(owned, { mode: 0o700 });
    const marker = join(owned, '.owner');
    writeFileSync(marker, JSON.stringify({ nonce: 'a' }), { mode: 0o600 });
    verifyOwnedPath(owned, '.owner', 'a');
    assert.throws(() => verifyOwnedPath(owned, '.owner', 'b'));
    assert.ok(existsSync(marker));
    chmodSync(owned, 0o777);
    assert.throws(() => verifyOwnedPath(owned, '.owner', 'a'));
    chmodSync(owned, 0o700);
    symlinkSync(owned, join(path, 'alias'));
    assert.throws(() => verifyOwnedPath(join(path, 'alias'), '.owner', 'a'));
    assert.ok(existsSync(marker));
  }));
class Socket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }
  addEventListener(event, listener) {
    this.on(event, listener);
  }
  send(value) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
}
test('CDP timeout closes socket and rejects every pending request once', async () => {
  const socket = new Socket();
  const client = new CDP(socket, 20);
  const first = client.call('Runtime.evaluate');
  const second = client.call('Page.captureScreenshot');
  await Promise.all([assert.rejects(first, /timeout/), assert.rejects(second, /timeout/)]);
  assert.equal(socket.readyState, 3);
  assert.equal(client.pending.size, 0);
  await assert.rejects(client.call('Input.dispatchMouseEvent'), /unavailable/);
});
test('CDP disconnect and malformed replies reject pending calls', async () => {
  for (const action of [
    (socket) => socket.close(),
    (socket) => socket.emit('message', { data: 'invalid json' }),
  ]) {
    const socket = new Socket();
    const client = new CDP(socket, 100);
    const pending = client.call('Runtime.evaluate');
    action(socket);
    await assert.rejects(pending);
    assert.equal(client.pending.size, 0);
  }
});
test('bounded poll fails a held companion without accepting stale completion', async () => {
  let calls = 0;
  await assert.rejects(
    waitFor(
      'held companion',
      () => {
        calls++;
        return false;
      },
      20,
    ),
    /Timeout/,
  );
  assert.ok(calls > 0);
  for (const url of [
    'ws://localhost:1234/a',
    'ws://user@127.0.0.1:1234/a',
    'ws://127.0.0.1:1234/a?x=1',
    'wss://127.0.0.1:1234/a',
  ])
    assert.throws(() => loopback(url));
});

test('target selection rejects missing ambiguous nonce and foreign loopback ports', () => {
  const browser = loopback(endpoint);
  const target = {
    type: 'page',
    title: 'owned nonce',
    webSocketDebuggerUrl: 'ws://127.0.0.1:23456/devtools/page/abcd',
  };
  assert.equal(selectTarget([target], 'nonce', browser), target);
  for (const targets of [
    [],
    [target, target],
    [{ ...target, title: 'user workspace' }],
    [{ ...target, webSocketDebuggerUrl: 'ws://127.0.0.1:23457/devtools/page/abcd' }],
    [{ ...target, webSocketDebuggerUrl: 'ws://localhost:23456/devtools/page/abcd' }],
  ])
    assert.throws(() => selectTarget(targets, 'nonce', browser));
});
test('forced cleanup terminates only a captured fake process group and preserves changed markers', async () => {
  const temporary = mkdtempSync('/tmp/dcs-cleanup-unit-');
  const evidence = join(temporary, 'evidence');
  mkdirSync(evidence);
  const profilePath = join(temporary, 'profile');
  mkdirSync(profilePath, { mode: 0o700 });
  writeFileSync(
    join(profilePath, '.commit-state-owner.json'),
    JSON.stringify({ nonce: 'foreign' }),
    { mode: 0o600 },
  );
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  const host = { child, label: 'fake', captured: new Set([child.pid]), closed: false };
  child.once('close', () => {
    host.closed = true;
  });
  const session = Object.assign(Object.create(Session.prototype), {
    hosts: [host],
    evidence,
    nonce: 'owned',
    temporary,
    profile: { path: profilePath },
  });
  try {
    const result = await session.cleanup();
    assert.equal(result.forced, true);
    assert.equal(host.closed, true);
    assert.ok(result.leftovers.includes(profilePath));
    assert.ok(existsSync(join(profilePath, '.commit-state-owner.json')));
    assert.equal(session.capture(host).length, 0);
  } finally {
    if (!host.closed) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
    rmSync(temporary, { recursive: true });
  }
});
