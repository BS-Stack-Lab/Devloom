import assert from 'node:assert/strict';
import https from 'node:https';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { owned } from './transportCredentials.mjs';
import { relayCgi } from './transportCgi.mjs';

const MAX_BODY = 64 * 1024 * 1024;
const MAX_QUEUE = 1024 * 1024;
function reject(code, message) {
  return Object.assign(new Error(message), { status: code });
}
export function framing(request) {
  const fields = {};
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const key = request.rawHeaders[i].toLowerCase();
    (fields[key] ??= []).push(request.rawHeaders[i + 1].trim());
  }
  const length = fields['content-length'] ?? [];
  const transfer = fields['transfer-encoding'] ?? [];
  if (length.length > 1 || transfer.length > 1 || (length.length && transfer.length))
    throw reject(400, 'ambiguous-framing');
  if (fields.trailer) throw reject(400, 'declared-trailers');
  if (length.length && !/^[0-9]+$/.test(length[0])) throw reject(400, 'invalid-length');
  if (length.length && BigInt(length[0]) > BigInt(MAX_BODY)) throw reject(413, 'body-limit');
  if (transfer.length && transfer[0].toLowerCase() !== 'chunked')
    throw reject(400, 'unsupported-transfer');
  if (request.method === 'GET' && (transfer.length || (length.length && BigInt(length[0]) !== 0n)))
    throw reject(400, 'get-body');
  if (request.method === 'POST' && !length.length && !transfer.length)
    throw reject(411, 'length-required');
  return {
    mode: transfer.length ? 'chunked' : 'length',
    length: length.length ? Number(length[0]) : 0,
  };
}
export function route(request, remoteName) {
  if (request.method === 'GET') {
    const match = request.url.match(
      new RegExp(`^/${remoteName}/info/refs\\?service=(git-upload-pack|git-receive-pack)$`),
    );
    if (match)
      return { path: `/${remoteName}/info/refs`, query: `service=${match[1]}`, service: match[1] };
  }
  if (request.method === 'POST') {
    const match = request.url.match(
      new RegExp(`^/${remoteName}/(git-upload-pack|git-receive-pack)$`),
    );
    if (match && request.headers['content-type'] === `application/x-${match[1]}-request`)
      return { path: `/${remoteName}/${match[1]}`, query: '', service: match[1] };
  }
  throw reject(404, 'route-refused');
}
export function authenticate(header, expected) {
  if (typeof header !== 'string' || header.length > 512 || !/^Basic [A-Za-z0-9+/]+=*$/.test(header))
    return false;
  const value = Buffer.from(header.slice(6), 'base64');
  return value.length === expected.length && timingSafeEqual(value, expected);
}
export async function httpsServer(secret, remote, nonce, options = {}) {
  const leaf = secret.leaves[options.leaf ?? 'valid'];
  const events = [];
  const sockets = new Set();
  const tasks = new Set();
  const active = new Set();
  const pending = new Set();
  const name = `remote-${nonce}.git`;
  let busy = false;
  let control = '';
  let maximumQueued = 0;
  let spoolBytes = 0;
  let sequence = 0;
  const server = https.createServer({
    key: readFileSync(leaf.key),
    cert: readFileSync(leaf.cert),
    minVersion: 'TLSv1.2',
    maxHeaderSize: 16384,
    insecureHTTPParser: false,
    highWaterMark: 65536,
  });
  server.headersTimeout = 10000;
  server.requestTimeout = options.receiveTimeout ?? 30000;
  server.keepAliveTimeout = 1000;
  async function handle(request, response, expectation = false) {
    let spool;
    let output;
    let writeError;
    const token = {};
    let relayStarted = false;
    let admitted = false;
    let count = 0;
    let timer;
    const id = ++sequence;
    const event = (value) => events.push({ id, at: Date.now(), ...value });
    try {
      const selected = route(request, name);
      if (!authenticate(request.headers.authorization, secret.basic)) {
        event({ kind: 'auth-denied', service: selected.service });
        response.writeHead(401, {
          'WWW-Authenticate': 'Basic realm="Devloom synthetic fixture"',
          Connection: 'close',
          'Content-Length': '0',
        });
        response.end();
        return;
      }
      event({ kind: 'authenticated', service: selected.service });
      const frame = framing(request);
      if (request.headers.expect && request.headers.expect.toLowerCase() !== '100-continue')
        throw reject(417, 'expectation-refused');
      if (busy) throw reject(503, 'body-busy');
      busy = admitted = true;
      spool = join(secret.directory, `request-${randomBytes(16).toString('hex')}`);
      output = createWriteStream(spool, { flags: 'wx', mode: 0o600, highWaterMark: 65536 });
      output.on('error', (error) => {
        writeError = error;
        request.destroy();
      });
      timer = setTimeout(() => {
        event({ kind: 'receive-deadline' });
        request.destroy();
      }, options.receiveTimeout ?? 30000);
      if (expectation) response.writeContinue();
      const digest = createHash('sha256');
      for await (const bytes of request) {
        count += bytes.length;
        if (count > MAX_BODY) throw reject(413, 'body-limit');
        maximumQueued = Math.max(
          maximumQueued,
          request.readableLength + output.writableLength + bytes.length,
        );
        if (maximumQueued > MAX_QUEUE) throw reject(413, 'queue-limit');
        digest.update(bytes);
        if (!output.write(bytes)) await once(output, 'drain');
        if (writeError) throw writeError;
      }
      if (
        !request.complete ||
        request.aborted ||
        request.rawTrailers.length ||
        (!request.headers['transfer-encoding'] && count !== frame.length)
      )
        throw reject(400, 'incomplete-body');
      output.end();
      await once(output, 'close');
      if (writeError) throw writeError;
      clearTimeout(timer);
      timer = undefined;
      owned(spool);
      assert.equal(request.socket.destroyed, false);
      spoolBytes = Math.max(spoolBytes, count);
      event({
        kind: 'body-complete',
        mode: frame.mode,
        bytes: count,
        sha256: digest.digest('hex'),
        cgiLength: String(count),
      });
      pending.add(token);
      relayStarted = true;
      const result = await relayCgi({
        request: {
          method: request.method,
          contentType: request.headers['content-type'] ?? '',
          protocol: request.headers['git-protocol'],
        },
        response,
        remote,
        selected,
        spool,
        bytes: count,
        emptyGlobal: secret.empty,
        event,
        control: () => control,
        backend: options.backend,
        accounting: { active, token },
        lifecycle: options.lifecycle,
      });
      maximumQueued = Math.max(maximumQueued, result.maximumQueued);
      pending.delete(token);
      response.end();
    } catch (error) {
      event({
        kind: 'rejected',
        classification: writeError
          ? 'spool-write-failed'
          : error.status
            ? error.message
            : 'transport-aborted',
        status: error.status ?? null,
      });
      if (!response.headersSent && !response.destroyed)
        response
          .writeHead(error.status ?? 502, { Connection: 'close', 'Content-Length': '0' })
          .end();
      else response.destroy();
    } finally {
      clearTimeout(timer);
      if (output && !output.closed) {
        output.destroy();
        await once(output, 'close').catch(() => {});
      }
      if (spool && existsSync(spool) && !pending.has(token)) {
        owned(spool);
        unlinkSync(spool);
      }
      if (admitted && (!relayStarted || !pending.has(token))) busy = false;
    }
  }
  function schedule(request, response, expectation = false) {
    const task = handle(request, response, expectation);
    tasks.add(task);
    void task.then(
      () => tasks.delete(task),
      () => tasks.delete(task),
    );
  }
  server.on('request', schedule);
  server.on('checkContinue', (request, response) => schedule(request, response, true));
  server.on('checkExpectation', (request, response) => {
    events.push({ kind: 'expectation-refused', at: Date.now() });
    response.writeHead(417, { Connection: 'close' }).end();
  });
  server.on('clientError', (error, socket) => {
    events.push({
      kind: 'parser-rejected',
      code: /^HPE_/.test(error.code ?? '') ? error.code : 'socket-error',
      at: Date.now(),
    });
    socket.destroy();
  });
  server.on('tlsClientError', () => events.push({ kind: 'tls-rejected', at: Date.now() }));
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) =>
    server.once('error', reject).listen(0, '127.0.0.1', resolve),
  );
  const address = server.address();
  assert.equal(address.address, '127.0.0.1');
  return {
    protocol: 'https',
    url: `https://127.0.0.1:${address.port}/${name}`,
    port: address.port,
    events,
    setControl(value) {
      assert.ok(['', 'hold', 'drop', 'release', 'disconnect'].includes(value));
      control = value;
      if (value === 'disconnect') for (const socket of sockets) socket.destroy();
    },
    statistics: () => ({
      maximumQueued,
      spoolBytes,
      activeChildren: active.size,
      sockets: sockets.size,
    }),
    async close() {
      control = 'release';
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await Promise.allSettled([...tasks]);
      assert.equal(active.size, 0, 'Live HTTP backend preserved');
      assert.equal(pending.size, 0, 'Rejected HTTP relay obligation preserved');
    },
  };
}
