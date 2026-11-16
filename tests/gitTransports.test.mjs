import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  truncateSync,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';
import tls from 'node:tls';
import https from 'node:https';
import {
  credentials,
  cleanEnvironment,
  hash,
  privateFile,
  safeAncestors,
} from '../scripts/transportCredentials.mjs';
import { scanPublicEvidence } from '../scripts/runGitTransports.mjs';
import { waitFor } from '../scripts/commitStateUI.mjs';
import { authenticate, framing, httpsServer, route } from '../scripts/transportHttps.mjs';

let directory;
let secret;
let server;
let count = 0;
let initialRefs;
function fixtureGit(args, input = '') {
  return execFileSync(
    '/opt/homebrew/bin/git',
    ['--git-dir', join(directory, `remote-${nonce}.git`), ...args],
    {
      input,
      encoding: 'utf8',
      timeout: 10000,
      env: { ...cleanEnvironment(), GIT_CONFIG_GLOBAL: secret.empty, GIT_CONFIG_NOSYSTEM: '1' },
    },
  ).trim();
}
const nonce = randomBytes(16).toString('hex');
const endpoint = `/remote-${nonce}.git`;
const observations = [];
function backend(env) {
  const capture = join(directory, `capture-${++count}.json`);
  const source = `const fs=require('node:fs'),crypto=require('node:crypto');let n=0,h=crypto.createHash('sha256');process.stdin.on('data',b=>{n+=b.length;h.update(b)});process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({bytes:n,hash:h.digest('hex'),length:process.env.CONTENT_LENGTH,eof:1}),{mode:384});process.stdout.write('Content-Type: application/octet-stream\\r\\n\\r\\nunit-backend');});`;
  return spawn(process.execPath, ['-e', source], {
    env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
before(async () => {
  const parent = process.env.DEVLOOM_EVIDENCE_DIR;
  assert.ok(parent && isAbsolute(parent), 'An absolute external evidence parent is required');
  directory = mkdtempSync(join(parent, 'transport-units-'));
  chmodSync(directory, 0o700);
  secret = credentials(directory, nonce);
  execFileSync(
    '/opt/homebrew/bin/git',
    ['init', '--bare', join(directory, `remote-${nonce}.git`)],
    {
      env: { ...cleanEnvironment(), GIT_CONFIG_GLOBAL: secret.empty, GIT_CONFIG_NOSYSTEM: '1' },
      stdio: 'ignore',
    },
  );
  const tree = fixtureGit(['mktree']);
  const commit = fixtureGit([
    '-c',
    'user.name=Devloom fixture',
    '-c',
    'user.email=fixture@invalid',
    'commit-tree',
    tree,
    '-m',
    'fixture',
  ]);
  fixtureGit(['update-ref', 'refs/heads/main', commit]);
  initialRefs = fixtureGit(['show-ref']);
  server = await httpsServer(secret, join(directory, `remote-${nonce}.git`), nonce, {
    backend,
    receiveTimeout: 1000,
  });
});
after(async () => {
  let closureError;
  if (server)
    await server.close().catch((error) => {
      closureError = error;
    });
  if (directory) {
    privateFile(
      join(directory, 'unit-result.json'),
      JSON.stringify(
        {
          kind: 'synthetic-unit-only',
          count,
          observations,
          events: server?.events,
          statistics: server?.statistics(),
        },
        null,
        2,
      ),
    );
    if (
      secret &&
      !closureError &&
      !readdirSync(secret.directory).some((name) => name.startsWith('request-'))
    )
      rmSync(secret.directory, { recursive: true });
  }
  if (closureError) throw closureError;
});
const auth = () => `Authorization: Basic ${secret.basic.toString('base64')}\r\n`;
const head = (
  framing,
  extra = '',
  method = 'POST',
  path = `${endpoint}/git-receive-pack`,
  authorized = true,
) =>
  `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n${authorized ? auth() : ''}Content-Type: application/x-git-receive-pack-request\r\n${framing}${extra}\r\n`;
async function raw(parts, end = false, port = server.port, ca = secret.ca) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: '127.0.0.1',
      port,
      ca: readFileSync(ca),
      servername: undefined,
      rejectUnauthorized: true,
    });
    let response = '';
    let error;
    const deadline = setTimeout(() => {
      socket.destroy();
      reject(new Error('Unit socket did not close'));
    }, 20000);
    socket.once('secureConnect', async () => {
      try {
        for (const part of parts)
          if (!socket.write(part)) await new Promise((done) => socket.once('drain', done));
        if (end) socket.end();
      } catch (value) {
        error = value.code;
      }
    });
    socket.on('data', (bytes) => {
      response += bytes;
      assert.ok(response.length < 65536);
    });
    socket.on('error', (value) => {
      error = value.code;
    });
    socket.once('close', () => {
      clearTimeout(deadline);
      resolve({ response, error });
    });
  });
}
async function denied(name, parts, status, end = false) {
  const before = count;
  const event = server.events.length;
  const preexistingSpools = new Set(
    readdirSync(secret.directory).filter((name) => name.startsWith('request-')),
  );
  const value = await raw(parts, end);
  await waitFor(
    `denied ${name} request resources closed`,
    () => {
      const statistics = server.statistics();
      const requestEvents = server.events.slice(event);
      const requestIds = new Set(
        requestEvents.filter((item) => Number.isSafeInteger(item.id)).map((item) => item.id),
      );
      const settledIds = new Set(
        requestEvents.filter((item) => item.kind === 'request-settled').map((item) => item.id),
      );
      return (
        [...requestIds].every((id) => settledIds.has(id)) &&
        statistics.sockets === 0 &&
        statistics.activeChildren === 0 &&
        readdirSync(secret.directory)
          .filter((name) => name.startsWith('request-'))
          .every((name) => preexistingSpools.has(name))
      );
    },
    3000,
  );
  assert.equal(count, before, name);
  assert.equal(fixtureGit(['show-ref']), initialRefs, name);
  assert.ok(
    status
      ? value.response.includes(` ${status} `)
      : server.events
          .slice(event)
          .some((item) => /parser-rejected|rejected|receive-deadline/.test(item.kind)),
    JSON.stringify({ name, value, events: server.events.slice(event) }),
  );
  observations.push({
    name,
    zeroBackend: true,
    response: value.response.slice(0, 64),
    classification: server.events.slice(event).map((item) => item.kind),
  });
}
async function accepted(name, parts, payload) {
  const before = count;
  const value = await raw(parts);
  assert.match(value.response, /HTTP\/1.1 200/);
  assert.equal(count, before + 1);
  const captured = JSON.parse(readFileSync(join(directory, `capture-${count}.json`), 'utf8'));
  assert.deepEqual(captured, {
    bytes: Buffer.isBuffer(payload) ? payload.length : payload.bytes,
    hash: Buffer.isBuffer(payload) ? hash(payload) : payload.hash,
    length: String(Buffer.isBuffer(payload) ? payload.length : payload.bytes),
    eof: 1,
  });
  assert.equal(fixtureGit(['show-ref']), initialRefs, name);
  observations.push({ name, captured });
}
test('fixture boundary rejects environment contamination without touching native askpass IPC', () => {
  const environment = cleanEnvironment({
    HOME: '/unchanged',
    GIT_ASKPASS: '/native/askpass',
    VSCODE_GIT_IPC_HANDLE: '/native/ipc',
    GIT_CONFIG_GLOBAL: '/foreign',
    GIT_INDEX_FILE: '/foreign',
    GIT_SSL_NO_VERIFY: '1',
    HTTPS_PROXY: 'foreign',
    SSH_AUTH_SOCK: '/foreign',
    GIT_SSH_COMMAND: 'foreign',
    SSL_CERT_FILE: '/foreign',
  });
  assert.deepEqual(environment, {
    HOME: '/unchanged',
    GIT_ASKPASS: '/native/askpass',
    VSCODE_GIT_IPC_HANDLE: '/native/ipc',
  });
  assert.equal(
    authenticate('Basic ' + Buffer.from('wrong:wrong').toString('base64'), secret.basic),
    false,
  );
  assert.equal(authenticate('Basic ' + secret.basic.toString('base64'), secret.basic), true);
  assert.equal(authenticate('Basic $$$', secret.basic), false);
});
test('route and framing validators reject aliases and raw duplicate headers', () => {
  for (const path of [
    `${endpoint}%2fgit-upload-pack`,
    `${endpoint}/../info/refs?service=git-upload-pack`,
    `${endpoint}/info/refs?service=git-upload-pack&extra=1`,
  ])
    assert.throws(() => route({ method: 'GET', url: path }, endpoint.slice(1)), /route-refused/);
  for (const rawHeaders of [
    ['Content-Length', '0', 'Content-Length', '0'],
    ['Transfer-Encoding', 'chunked', 'Transfer-Encoding', 'chunked'],
    ['Content-Length', '1', 'Transfer-Encoding', 'chunked'],
    ['Content-Length', '1,1'],
  ])
    assert.throws(() => framing({ method: 'POST', rawHeaders }), /ambiguous|invalid/);
  assert.throws(() => safeAncestors('/tmp'), /Unsafe SSH ancestry/);
});
test('length framing forwards fragmented binary and exact zero/one byte EOF', async () => {
  for (const payload of [
    Buffer.alloc(0),
    Buffer.from([0]),
    Buffer.from('0010\r\nhex\0\xff\r\n0\r\n\r\n'),
  ])
    await accepted(
      `length-${payload.length}`,
      [
        head(`Content-Length: ${payload.length}\r\nConnection: close\r\n`),
        ...Array.from(payload, (byte) => Buffer.from([byte])),
      ],
      payload,
    );
});
test('chunked framing dechunks arbitrary split binary without marker leakage', async () => {
  const a = Buffer.from('raw\r\n0\r\n\0');
  const b = randomBytes(23);
  const payload = Buffer.concat([a, b]);
  const wire = Buffer.concat([
    Buffer.from(head('Transfer-Encoding: chunked\r\nConnection: close\r\n')),
    Buffer.from(`${a.length.toString(16)};unit=yes\r\n`),
    a,
    Buffer.from(`\r\n${b.length.toString(16)}\r\n`),
    b,
    Buffer.from('\r\n0\r\n\r\n'),
  ]);
  await accepted(
    'chunked-binary',
    Array.from(wire, (byte) => Buffer.from([byte])),
    payload,
  );
});
test('strict parser rejects every ambiguous or invalid framing before backend', async () => {
  for (const fields of [
    'Content-Length: 0\r\nTransfer-Encoding: chunked\r\n',
    'Content-Length: 0\r\nContent-Length: 0\r\n',
    'Content-Length: 0\r\nContent-Length: 1\r\n',
    'Transfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n',
    'Content-Length: 0,0\r\n',
    'Content-Length: -1\r\n',
    'Content-Length: +1\r\n',
    'Content-Length: abc\r\n',
    'Content-Length: 999999999999999999999999999999999999\r\n',
    'Transfer-Encoding: gzip, chunked\r\n',
    'Transfer-Encoding: gzip\r\n',
  ])
    await denied(fields.split('\r\n')[0], [head(fields)], undefined);
  await denied('missing-length', [head('')], 411);
  await denied('over-limit', [head('Content-Length: 67108865\r\n')], 413);
});
test('auth is checked before body, spool and backend; denied route cannot dispatch', async () => {
  await denied(
    'missing-auth-expect',
    [
      head(
        'Content-Length: 5000\r\n',
        'Expect: 100-continue\r\n',
        'POST',
        `${endpoint}/git-receive-pack`,
        false,
      ),
    ],
    401,
  );
  assert.equal(
    readdirSync(secret.directory).filter((name) => name.startsWith('request-')).length,
    0,
  );
  await denied(
    'unknown-route',
    [head('Content-Length: 0\r\n', '', 'POST', '/unowned/git-receive-pack')],
    404,
  );
});
test('GET, expectations and trailers fail for intended policy class', async () => {
  await denied(
    'get-body',
    [
      head('Content-Length: 1\r\n', '', 'GET', `${endpoint}/info/refs?service=git-upload-pack`),
      'x',
    ],
    400,
  );
  await denied('unsupported-expect', [head('Content-Length: 0\r\n', 'Expect: other\r\n')], 417);
  await denied(
    'declared-trailers',
    [head('Transfer-Encoding: chunked\r\n', 'Trailer: X-Test\r\n')],
    400,
  );
  await denied(
    'actual-trailers',
    [head('Transfer-Encoding: chunked\r\n'), '1\r\nx\r\n0\r\nX-Test: value\r\n\r\n'],
    400,
  );
  await accepted(
    'continue',
    [head('Content-Length: 1\r\nConnection: close\r\n', 'Expect: 100-continue\r\n'), 'x'],
    Buffer.from('x'),
  );
  await accepted(
    'empty-get',
    [head('Connection: close\r\n', '', 'GET', `${endpoint}/info/refs?service=git-upload-pack`)],
    Buffer.alloc(0),
  );
});
test('truncated lengths/chunks and parser faults cannot dispatch; receive deadline closes', async () => {
  await denied('truncated-length', [head('Content-Length: 10\r\n'), 'x'], undefined, true);
  await denied(
    'truncated-chunk',
    [head('Transfer-Encoding: chunked\r\n'), 'a\r\nx'],
    undefined,
    true,
  );
  await denied(
    'bad-chunk',
    [head('Transfer-Encoding: chunked\r\n'), 'Z\r\nx\r\n0\r\n\r\n'],
    undefined,
  );
  await denied('receive-deadline', [head('Content-Length: 10\r\n'), 'x'], undefined);
  assert.equal(
    readdirSync(secret.directory).some((name) => name.startsWith('request-')),
    false,
  );
});
test('64 MiB streaming limit and aggregate queue bounds are independently enforced', async () => {
  const block = Buffer.alloc(65536, 101);
  const size = 64 * 1024 * 1024;
  const expectedHash = createHash('sha256');
  for (let index = 0; index < 1024; index++) expectedHash.update(block);
  const payload = { bytes: size, hash: expectedHash.digest('hex') };
  await accepted(
    '64MiB-length',
    [head(`Content-Length: ${size}\r\nConnection: close\r\n`), ...Array(1024).fill(block)],
    payload,
  );
  const before = count;
  const wire = [
    head('Transfer-Encoding: chunked\r\n'),
    ...Array(1024).fill(Buffer.concat([Buffer.from('10000\r\n'), block, Buffer.from('\r\n')])),
    '1\r\nx\r\n0\r\n\r\n',
  ];
  await denied('64MiB-plus-one-chunked', wire, undefined);
  assert.equal(count, before);
  assert.ok(server.statistics().maximumQueued <= 1024 * 1024);
});
test('trust failures occur before HTTP auth/backend with healthy positive control', async () => {
  await accepted(
    'trust-control',
    [head('Content-Length: 0\r\nConnection: close\r\n')],
    Buffer.alloc(0),
  );
  for (const leaf of ['foreign', 'wrong-san']) {
    const endpointServer = await httpsServer(
      secret,
      join(directory, `remote-${nonce}.git`),
      nonce,
      { leaf, backend },
    );
    const before = count;
    try {
      const value = await raw([head('Content-Length: 0\r\n')], false, endpointServer.port);
      assert.match(
        value.error ?? '',
        leaf === 'wrong-san'
          ? /ERR_TLS_CERT_ALTNAME_INVALID/
          : /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY/,
      );
      assert.equal(count, before);
      assert.equal(
        endpointServer.events.some((item) => item.kind === 'authenticated'),
        false,
      );
    } finally {
      await endpointServer.close();
    }
  }
});
test('mandatory registration precedes every fallible identity and notification boundary', async () => {
  for (const boundary of ['identity-capture', 'registered', 'spawned', 'notified']) {
    let child;
    let reached = false;
    const endpointServer = await httpsServer(
      secret,
      join(directory, `remote-${nonce}.git`),
      nonce,
      {
        backend: (env) => {
          const ready = join(directory, `ready-${boundary}`);
          child = spawn(
            process.execPath,
            [
              '-e',
              `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`,
            ],
            {
              env,
              detached: true,
              stdio: ['pipe', 'pipe', 'pipe'],
            },
          );
          const deadline = Date.now() + 1000;
          let group;
          while (Date.now() < deadline && (group !== String(child.pid) || !existsSync(ready))) {
            group = execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'pgid='], {
              encoding: 'utf8',
            }).trim();
          }
          assert.equal(group, String(child.pid));
          assert.equal(existsSync(ready), true);
          process.kill(child.pid, 'SIGSTOP');
          return child;
        },
        lifecycle: (stage) => {
          if (stage === boundary) {
            reached = true;
            throw new Error('Synthetic lifecycle failure');
          }
        },
      },
    );
    try {
      const response = await raw(
        [head('Content-Length: 0\r\nConnection: close\r\n')],
        false,
        endpointServer.port,
      );
      assert.match(response.response, /502/);
      assert.equal(reached, true);
      assert.equal(endpointServer.statistics().activeChildren, 1);
      assert.doesNotThrow(() => process.kill(child.pid, 0));
      await assert.rejects(endpointServer.close(), /Live HTTP backend preserved/);
      assert.ok(readdirSync(secret.directory).some((name) => name.startsWith('request-')));
      observations.push({ name: `atomic-${boundary}`, activeWhileHeld: 1, rejectedClose: true });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise((resolve) => child.once('close', resolve));
        process.kill(-child.pid, 'SIGKILL');
        await closed;
      }
    }
  }
});
test('failed spawn and pre-spawn rejection retain obligation without inventing an active child', async () => {
  for (const mode of ['throw', 'failed-spawn']) {
    const endpointServer = await httpsServer(
      secret,
      join(directory, `remote-${nonce}.git`),
      nonce,
      {
        backend: (env) => {
          if (mode === 'throw') throw new Error('Synthetic factory rejection');
          return spawn(join(directory, 'nonexistent-executable'), [], {
            env,
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        },
      },
    );
    const response = await raw(
      [head('Content-Length: 0\r\nConnection: close\r\n')],
      false,
      endpointServer.port,
    );
    assert.match(response.response, /502/);
    assert.equal(endpointServer.statistics().activeChildren, 0);
    await assert.rejects(endpointServer.close(), /Rejected HTTP relay obligation preserved/);
    assert.ok(readdirSync(secret.directory).some((name) => name.startsWith('request-')));
    observations.push({ name: mode, activeChildren: 0, rejectedClose: true });
  }
});
test('direct child close cannot release a captured held descendant', async () => {
  let child;
  const ready = join(directory, 'descendant-ready.json');
  const descendant = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}),{mode:384});setInterval(()=>{},1000);`;
  const endpointServer = await httpsServer(secret, join(directory, `remote-${nonce}.git`), nonce, {
    backend: (env) => {
      const source = `const cp=require('node:child_process'),fs=require('node:fs');cp.spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});process.stdin.resume();process.stdin.on('end',()=>{const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(t);process.stdout.write('Content-Type: application/octet-stream\\r\\n\\r\\nheld-descendant');setTimeout(()=>process.exit(0),350)}},10)});`;
      child = spawn(process.execPath, ['-e', source], {
        env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return child;
    },
  });
  let descendantPid;
  try {
    const response = raw(
      [head('Content-Length: 0\r\nConnection: close\r\n')],
      false,
      endpointServer.port,
    );
    await waitFor('real owned descendant ready', () => existsSync(ready), 3000);
    descendantPid = JSON.parse(readFileSync(ready, 'utf8')).pid;
    await waitFor('real direct child closed', () => child.exitCode !== null, 3000);
    assert.equal(endpointServer.statistics().activeChildren, 1);
    assert.doesNotThrow(() => process.kill(descendantPid, 0));
    endpointServer.setControl('disconnect');
    await response;
    await assert.rejects(endpointServer.close(), /Live HTTP backend preserved/);
    assert.equal(endpointServer.statistics().activeChildren, 1);
    assert.ok(readdirSync(secret.directory).some((name) => name.startsWith('request-')));
    observations.push({
      name: 'held-descendant',
      directClosed: true,
      activeChildren: 1,
      rejectedClose: true,
    });
  } finally {
    if (descendantPid) {
      const group = execFileSync('/bin/ps', ['-p', String(descendantPid), '-o', 'pgid='], {
        encoding: 'utf8',
      }).trim();
      assert.equal(group, String(child.pid));
      process.kill(-child.pid, 'SIGKILL');
      await waitFor(
        'owned descendant reaped',
        () => {
          try {
            process.kill(descendantPid, 0);
            return false;
          } catch (error) {
            if (error.code === 'ESRCH') return true;
            throw error;
          }
        },
        3000,
      );
    }
  }
});
test('ambiguous returned group remains active and cannot kill its unowned group', async () => {
  let child;
  const ready = join(directory, 'ambiguous-ready');
  const endpointServer = await httpsServer(secret, join(directory, `remote-${nonce}.git`), nonce, {
    backend: (env) => {
      child = spawn(
        process.execPath,
        [
          '-e',
          `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready',{mode:384});setInterval(()=>{},1000)`,
        ],
        { env, detached: false, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      return child;
    },
  });
  try {
    const response = await raw(
      [head('Content-Length: 0\r\nConnection: close\r\n')],
      false,
      endpointServer.port,
    );
    assert.match(response.response, /502/);
    await waitFor('ambiguous child alive', () => existsSync(ready), 3000);
    assert.equal(endpointServer.statistics().activeChildren, 1);
    await assert.rejects(endpointServer.close(), /Live HTTP backend preserved/);
    assert.doesNotThrow(() => process.kill(child.pid, 0));
    observations.push({ name: 'ambiguous-group', activeChildren: 1, groupNotSignalled: true });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once('close', resolve));
      process.kill(child.pid, 'SIGKILL');
      await closed;
    }
  }
});
test('closed notification failure retains obligation without inventing a live child', async () => {
  const endpointServer = await httpsServer(secret, join(directory, `remote-${nonce}.git`), nonce, {
    backend,
    lifecycle: (stage) => {
      if (stage === 'closed') throw new Error('Synthetic closed notification failure');
    },
  });
  const response = await raw(
    [head('Content-Length: 0\r\nConnection: close\r\n')],
    false,
    endpointServer.port,
  );
  assert.match(response.response, /200/);
  assert.equal(endpointServer.statistics().activeChildren, 0);
  await assert.rejects(endpointServer.close(), /Rejected HTTP relay obligation preserved/);
  assert.ok(readdirSync(secret.directory).some((name) => name.startsWith('request-')));
  observations.push({ name: 'closed-notification', activeChildren: 0, rejectedClose: true });
});
test('overlapping body admission and an actual spool write error never dispatch', async () => {
  const priorSpools = readdirSync(secret.directory).filter((name) =>
    name.startsWith('request-'),
  ).length;
  const pending = raw([head('Content-Length: 10\r\n'), 'x']);
  await waitFor(
    'first private spool admitted',
    () =>
      readdirSync(secret.directory).filter((name) => name.startsWith('request-')).length >
      priorSpools,
    1000,
  );
  await denied('overlapping-body', [head('Content-Length: 0\r\n')], 503);
  await pending;
  await waitFor(
    'first admitted body cleanup finished',
    () =>
      readdirSync(secret.directory).filter((name) => name.startsWith('request-')).length ===
      priorSpools,
    1000,
  );
  const before = count;
  chmodSync(secret.directory, 0o500);
  try {
    const start = server.events.length;
    await raw([head('Content-Length: 1\r\n'), 'x']);
    assert.equal(count, before);
    assert.ok(
      server.events.slice(start).some((event) => event.classification === 'spool-write-failed'),
    );
    observations.push({ name: 'spool-write-failed', zeroBackend: true });
  } finally {
    chmodSync(secret.directory, 0o700);
  }
});
test('recursive evidence scanner rejects secrets and unsafe exports without exposing values', () => {
  const root = join(directory, 'scanner');
  const privateRoot = join(root, 'private');
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(privateRoot, { mode: 0o700 });
  privateFile(join(privateRoot, 'credentials'), secret.username);
  const exported = privateFile(join(root, 'export.json'), 'safe public metadata');
  assert.deepEqual(scanPublicEvidence(root, secret.secrets, privateRoot), {
    scannedFiles: 1,
    skippedPrivateRoots: 1,
  });
  const rejected = (code) => (error) => {
    assert.equal(error.code, code);
    for (const value of secret.secrets) assert.equal(String(error).includes(value), false);
    return true;
  };
  for (const value of [
    secret.username,
    secret.password,
    secret.basic.toString('base64'),
    '-----BEGIN PRIVATE KEY-----',
    'Authorization: Basic synthetic',
  ]) {
    writeFileSync(exported, value);
    assert.throws(
      () => scanPublicEvidence(root, secret.secrets, privateRoot),
      rejected('PUBLIC_EVIDENCE_SENSITIVE'),
    );
  }
  writeFileSync(exported, 'safe public metadata');
  chmodSync(exported, 0o644);
  assert.throws(
    () => scanPublicEvidence(root, secret.secrets, privateRoot),
    rejected('PUBLIC_EVIDENCE_UNSAFE'),
  );
  chmodSync(exported, 0o600);
  const link = join(root, 'foreign-link');
  symlinkSync(exported, link);
  assert.throws(
    () => scanPublicEvidence(root, secret.secrets, privateRoot),
    rejected('PUBLIC_EVIDENCE_UNSAFE'),
  );
  rmSync(link);
  const oversized = privateFile(join(root, 'oversized'), '');
  truncateSync(oversized, 8 * 1024 * 1024 + 1);
  assert.throws(
    () => scanPublicEvidence(root, secret.secrets, privateRoot),
    rejected('PUBLIC_EVIDENCE_BOUND'),
  );
  rmSync(oversized);
  assert.deepEqual(scanPublicEvidence(root, secret.secrets, privateRoot), {
    scannedFiles: 1,
    skippedPrivateRoots: 1,
  });
  rmSync(privateRoot, { recursive: true });
  observations.push({
    name: 'recursive-export-privacy',
    exactSecretRejection: true,
    skippedPrivateRoot: true,
    unsafeAndOversizedRejected: true,
  });
});
test('partial/oversized CGI headers and a short stdin reject with retained obligations', async () => {
  for (const mode of ['partial-header', 'oversized-header', 'short-stdin']) {
    const endpointServer = await httpsServer(
      secret,
      join(directory, `remote-${nonce}.git`),
      nonce,
      {
        backend: (env) => {
          const output =
            mode === 'partial-header'
              ? 'Content-Type: application/octet-stream\r\n'
              : mode === 'oversized-header'
                ? 'X'.repeat(16385)
                : 'Content-Type: application/octet-stream\r\n\r\nshort';
          const source =
            mode === 'short-stdin'
              ? `setTimeout(()=>process.stdout.write(${JSON.stringify(output)},()=>process.exit(0)),200);`
              : `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(output)}));`;
          return spawn(process.execPath, ['-e', source], {
            env,
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        },
      },
    );
    const payload = mode === 'short-stdin' ? Buffer.alloc(1024 * 1024, 42) : Buffer.alloc(0);
    await raw(
      [head(`Content-Length: ${payload.length}\r\nConnection: close\r\n`), payload],
      false,
      endpointServer.port,
    );
    assert.ok(endpointServer.events.some((event) => event.kind === 'backend-start'));
    assert.ok(endpointServer.events.some((event) => event.kind === 'rejected'));
    assert.equal(
      endpointServer.events.some((event) => event.kind === 'backend-close'),
      false,
    );
    await assert.rejects(endpointServer.close(), /Live HTTP backend preserved/);
    assert.equal(endpointServer.statistics().activeChildren, 1);
    assert.equal(fixtureGit(['show-ref']), initialRefs);
    observations.push({ name: mode, rejectedClose: true, remoteRefsUnchanged: true });
  }
});
test('slow verified TLS response drains a real CGI stream with bounded aggregate queues', async () => {
  const block = Buffer.alloc(65536, 23);
  const expected = createHash('sha256');
  for (let index = 0; index < 128; index++) expected.update(block);
  const endpointServer = await httpsServer(secret, join(directory, `remote-${nonce}.git`), nonce, {
    backend: (env) => {
      const source = `const events=require('node:events');process.stdin.resume();process.stdin.on('end',async()=>{process.stdout.write('Content-Type: application/octet-stream\\r\\n\\r\\n');const b=Buffer.alloc(65536,23);for(let i=0;i<128;i++){if(!process.stdout.write(b))await events.once(process.stdout,'drain')}process.stdout.end()});`;
      return spawn(process.execPath, ['-e', source], {
        env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    },
  });
  try {
    const received = await new Promise((resolve, reject) => {
      const request = https.get(
        {
          hostname: '127.0.0.1',
          port: endpointServer.port,
          path: `${endpoint}/info/refs?service=git-upload-pack`,
          ca: readFileSync(secret.ca),
          rejectUnauthorized: true,
          headers: { Authorization: `Basic ${secret.basic.toString('base64')}` },
        },
        (response) => {
          assert.equal(response.statusCode, 200);
          const digest = createHash('sha256');
          let bytes = 0;
          response.pause();
          setTimeout(() => response.resume(), 100);
          response.on('data', (chunk) => {
            bytes += chunk.length;
            digest.update(chunk);
          });
          response.once('error', reject);
          response.once('end', () =>
            resolve({ bytes, hash: digest.digest('hex'), complete: response.complete }),
          );
        },
      );
      request.setTimeout(5000, () => request.destroy(new Error('Bounded slow client deadline')));
      request.once('error', reject);
    });
    assert.deepEqual(received, {
      bytes: 8 * 1024 * 1024,
      hash: expected.digest('hex'),
      complete: true,
    });
    assert.ok(endpointServer.statistics().maximumQueued <= 1024 * 1024);
    assert.equal(endpointServer.statistics().activeChildren, 0);
    assert.equal(fixtureGit(['show-ref']), initialRefs);
    observations.push({
      name: 'slow-output-backpressure',
      bytes: received.bytes,
      maximumQueued: endpointServer.statistics().maximumQueued,
    });
  } finally {
    await endpointServer.close();
  }
});
test('public unit evidence never contains generated authentication material', () => {
  const text = JSON.stringify({ events: server.events, observations });
  for (const value of secret.secrets) assert.equal(text.includes(value), false);
  assert.equal(text.includes('PRIVATE KEY'), false);
  assert.equal(text.includes('Authorization'), false);
  assert.equal(existsSync(join(secret.directory, 'valid.key')), true);
  assert.equal(createHash('sha256').update('test').digest('hex').length, 64);
  mkdirSync(join(directory, 'unit-complete'), { mode: 0o700 });
});
