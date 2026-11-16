import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { setInterval, clearInterval } from 'node:timers';
import { cleanEnvironment, run } from './transportCredentials.mjs';
import { delay } from './commitStateUI.mjs';

function identities() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,uid=,lstart=,comm='], {
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 1024 * 1024,
  })
    .trim()
    .split('\n')
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(.{24})\s+(.+)$/);
      assert.ok(match, 'Unrecognized process identity');
      return {
        pid: +match[1],
        parent: +match[2],
        group: +match[3],
        uid: +match[4],
        start: match[5],
        command: match[6],
      };
    });
}
export async function relayCgi({
  request,
  response,
  remote,
  selected,
  spool,
  bytes,
  emptyGlobal,
  event,
  control,
  backend,
  accounting,
  lifecycle = () => {},
}) {
  const env = {
    ...cleanEnvironment(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyGlobal,
    GIT_PROJECT_ROOT: dirname(remote),
    PATH_INFO: selected.path,
    REQUEST_METHOD: request.method,
    QUERY_STRING: selected.query,
    CONTENT_TYPE: request.contentType,
    CONTENT_LENGTH: String(bytes),
    REMOTE_USER: 'fixture',
    REMOTE_ADDR: '127.0.0.1',
    SERVER_PROTOCOL: 'HTTP/1.1',
  };
  assert.ok(['GET', 'POST'].includes(request.method));
  if (request.protocol !== undefined) {
    assert.equal(request.protocol, 'version=2');
    env.HTTP_GIT_PROTOCOL = request.protocol;
  }
  const factory =
    backend ??
    ((environment) =>
      spawn(join(run('/opt/homebrew/bin/git', ['--exec-path']), 'git-http-backend'), [], {
        env: environment,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }));
  let child;
  let input;
  let closed = false;
  let result;
  let timer;
  let monitor;
  let failure;
  let inputBytes = 0;
  let responseBytes = 0;
  let maximumQueued = 0;
  const captured = new Map();
  const deadline = Date.now() + 30000;
  const remember = () => {
    const tree = identities();
    const direct = tree.find((row) => row.pid === child.pid);
    if (direct) {
      assert.equal(direct.group, child.pid, 'Backend group mismatch');
      assert.equal(direct.uid, process.getuid(), 'Backend owner mismatch');
      assert.equal(direct.parent, process.pid, 'Backend parent mismatch');
    } else assert.ok(captured.has(child.pid), 'Missing live backend identity');
    for (const row of tree.filter((row) => row.group === child.pid)) {
      assert.equal(row.uid, process.getuid());
      const previous = captured.get(row.pid);
      if (previous) assert.equal(previous.start, row.start, 'Backend PID reused');
      else captured.set(row.pid, row);
    }
    for (const previous of captured.values()) {
      const current = tree.find((row) => row.pid === previous.pid);
      if (current) {
        assert.equal(current.start, previous.start, 'Captured PID reused');
        assert.equal(current.group, child.pid, 'Captured process escaped group');
      }
    }
    return tree.filter((row) => captured.has(row.pid));
  };
  const stop = () => {
    input?.destroy();
    if (!child?.pid) return;
    try {
      const live = remember();
      if (live.length) process.kill(-child.pid, 'SIGTERM');
      child.stdin.destroy();
      child.stdout.destroy();
    } catch (error) {
      failure ??= error;
    }
  };
  const lost = () => {
    if (!response.writableFinished) stop();
  };
  const bounded = async (promise) => {
    let timeout;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('CGI operation deadline')),
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };
  try {
    child = factory(env);
    if (child.pid !== undefined) accounting.active.add(accounting.token);
    child.on('error', (error) => {
      failure ??= error;
    });
    const closing = new Promise((resolve) =>
      child.once('close', (code, signal) => {
        closed = true;
        result = { code, signal };
        resolve();
      }),
    );
    lifecycle('identity-capture');
    remember();
    lifecycle('registered');
    lifecycle('spawned');
    lifecycle('notified');
    assert.ok(child.pid, 'Backend spawn failed');
    event({ kind: 'backend-start', pid: child.pid, service: selected.service });
    monitor = setInterval(() => {
      try {
        remember();
      } catch (error) {
        failure ??= error;
        stop();
      }
    }, 100);
    timer = setTimeout(stop, 30000);
    response.once('close', lost);
    child.stderr.on('data', () => {});
    child.stdin.on('error', (error) => {
      failure ??= error;
    });
    if (['hold', 'drop'].includes(control())) {
      const mode = control();
      child.stdout.pause();
      event({ kind: 'held', service: selected.service });
      const end = Date.now() + 15000;
      while (control() === mode && Date.now() < end && !response.destroyed) await delay(25);
      if (mode === 'drop') {
        stop();
        response.destroy();
        throw new Error('Authenticated stream dropped');
      }
    }
    input = createReadStream(spool, { highWaterMark: 65536 });
    const readerClosed = new Promise((resolve) => input.once('close', resolve));
    const pumping = (async () => {
      for await (const chunk of input) {
        inputBytes += chunk.length;
        assert.ok(inputBytes <= bytes);
        maximumQueued = Math.max(maximumQueued, chunk.length + child.stdin.writableLength);
        assert.ok(maximumQueued <= 1024 * 1024);
        if (!child.stdin.write(chunk)) await bounded(once(child.stdin, 'drain'));
      }
      assert.equal(inputBytes, bytes);
      child.stdin.end();
    })();
    pumping.catch((error) => {
      failure ??= error;
      stop();
    });
    let header = Buffer.alloc(0);
    let headersDone = false;
    await bounded(
      (async () => {
        for await (const chunk of child.stdout) {
          responseBytes += chunk.length;
          assert.ok(responseBytes <= 128 * 1024 * 1024);
          let body = chunk;
          if (!headersDone) {
            header = Buffer.concat([header, chunk]);
            const separator = header.indexOf('\r\n\r\n');
            assert.ok(separator >= 0 ? separator <= 16384 : header.length <= 16384);
            if (separator < 0) continue;
            const fields = {};
            let status = 200;
            for (const line of header.subarray(0, separator).toString().split('\r\n')) {
              const match = line.match(/^([A-Za-z-]+):\s*(.*)$/);
              assert.ok(match);
              const key = match[1].toLowerCase();
              if (key === 'status') {
                assert.match(match[2], /^[1-5]\d{2}(?: [^\r\n]*)?$/);
                status = Number(match[2].slice(0, 3));
              } else {
                assert.ok(['content-type', 'expires', 'pragma', 'cache-control'].includes(key));
                assert.equal(fields[key], undefined);
                fields[key] = match[2];
              }
            }
            response.writeHead(status, fields);
            body = header.subarray(separator + 4);
            header = Buffer.alloc(0);
            headersDone = true;
          }
          maximumQueued = Math.max(maximumQueued, response.writableLength + body.length);
          assert.ok(maximumQueued <= 1024 * 1024);
          assert.equal(response.destroyed, false);
          if (!response.write(body)) await bounded(once(response, 'drain'));
        }
      })(),
    );
    await bounded(Promise.all([pumping, readerClosed, closing]));
    assert.ok(!failure, 'Backend stream failed');
    assert.equal(result.code, 0);
    assert.equal(headersDone, true);
    while (remember().length && Date.now() < deadline) {
      assert.equal(response.destroyed, false, 'Response lost while descendants remain');
      if (failure) throw failure;
      await delay(25);
    }
    assert.equal(remember().length, 0, 'Backend descendants preserved');
    assert.ok(input.closed && closed);
    accounting.active.delete(accounting.token);
    lifecycle('closed');
    event({ kind: 'backend-close', pid: child.pid, ...result, inputBytes, responseBytes });
    return { inputBytes, responseBytes, maximumQueued, ...result, pid: child.pid };
  } catch (error) {
    stop();
    const end = Date.now() + 1000;
    while (child?.pid && !closed && Date.now() < end) await delay(25);
    event({ kind: 'relay-failure', classification: error.message });
    throw error;
  } finally {
    clearTimeout(timer);
    clearInterval(monitor);
    response.removeListener('close', lost);
  }
}
