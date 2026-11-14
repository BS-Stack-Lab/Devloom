import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { BridgeClient } from '../extensions/devloom-bootstrap/src/bridgeClient';
import { encode, FrameDecoder } from '../extensions/devloom-bootstrap/src/framing';
const binary = resolve('crates/devloom-sidecar/target/debug/devloom-sidecar');
const fixture = resolve('dist/tests/childFixture.js');
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function gone(pid: number) {
  for (let i = 0; i < 60 && alive(pid); i++) await sleep(50);
  assert.equal(alive(pid), false);
}
test(
  'actual Rust hello unicode cancellation timeout crash restart and stop',
  { timeout: 15000 },
  async () => {
    const client = new BridgeClient(binary);
    try {
      const starts = [client.start(), client.start()];
      assert.equal(starts[0], starts[1]);
      const hello = await starts[0];
      assert.equal(hello.protocolMajor, 1);
      assert.deepEqual(await client.start(), hello);
      for (const text of [
        '',
        '한글 e\u0301 👨‍👩‍👧‍👦\n',
        'x'.repeat(8192),
        '$(touch SHOULD_NOT_EXIST);`false`',
      ])
        assert.deepEqual(await client.request('echo', { text }), { text });
      const controller = new AbortController();
      const delayed = client.request(
        'delay',
        { text: 'cancelled', delayMs: 2500 },
        { signal: controller.signal },
      );
      controller.abort();
      await assert.rejects(delayed, /Cancelled/);
      await assert.rejects(
        client.request('delay', { text: '', delayMs: 20 }, { signal: controller.signal }),
        /Cancelled/,
      );
      await assert.rejects(
        client.request('delay', { text: 'late', delayMs: 50 }, { timeoutMs: 5 }),
        /Timeout/,
      );
      await sleep(80);
      assert.deepEqual(await client.request('echo', { text: 'after timeout' }), {
        text: 'after timeout',
      });
      const pending = Array.from({ length: 16 }, () =>
        client.request('delay', { text: '', delayMs: 10000 }),
      );
      const outcomes = Promise.allSettled(pending);
      await assert.rejects(client.request('echo', { text: '' }), /Busy/);
      const oldPid = client.pid!;
      process.kill(oldPid, 'SIGKILL');
      assert.ok((await outcomes).every((entry) => entry.status === 'rejected'));
      await gone(oldPid);
      await client.restart();
      assert.notEqual(client.pid, oldPid);
      assert.equal(client.generation, 2);
      assert.deepEqual(await client.request('echo', { text: 'recovered' }), { text: 'recovered' });
      const finalPid = client.pid!;
      const stopping = client.request('delay', { text: '', delayMs: 10000 });
      const rejected = assert.rejects(stopping, /Stopped/);
      await client.stop();
      await rejected;
      await gone(finalPid);
      assert.equal(client.diagnostics.pending, 0);
      await client.stop();
    } finally {
      await client.stop();
    }
  },
);
test(
  'malformed and incompatible fake responses terminate their owned child',
  { timeout: 10000 },
  async () => {
    for (const mode of ['malformed', 'mismatch']) {
      const client = new BridgeClient(process.execPath, [fixture, mode]);
      const start = client.start();
      const pid = client.pid!;
      await assert.rejects(start, /InvalidResponse/);
      assert.equal(client.state, 'failed');
      await gone(pid);
      await client.stop();
    }
  },
);
test('stubborn shutdown escalates only its owned fake child', { timeout: 6000 }, async () => {
  const client = new BridgeClient(process.execPath, [fixture, 'stubborn']);
  await client.start();
  const pid = client.pid!;
  await client.stop();
  await gone(pid);
  assert.equal(client.state, 'stopped');
});
async function raw(wires: Buffer[], end = true): Promise<unknown[]> {
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  const frames: unknown[] = [];
  const decoder = new FrameDecoder();
  child.stdout.on('data', (chunk: Buffer) => frames.push(...decoder.push(chunk)));
  child.stderr.resume();
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  for (const wire of wires) child.stdin.write(wire);
  if (end) child.stdin.end();
  const [code, signal] = await closed;
  clearTimeout(timer);
  assert.equal(signal, null);
  assert.equal(code, 0);
  return frames;
}
const packet = (id: number, method: string, params: unknown) =>
  encode({ jsonrpc: '2.0', id, method, params });
const hello = packet(1, 'hello', { protocolMajor: 1, protocolMinor: 0 });
test(
  'real Rust fragmented transport malformed bounds and protocol rejection',
  { timeout: 15000 },
  async () => {
    const echo = packet(2, 'echo', { text: '한글 🧵' });
    const frames = await raw(
      [...hello].map((b) => Buffer.from([b])).concat([...echo].map((b) => Buffer.from([b]))),
    );
    assert.equal(frames.length, 2);
    const before = await raw([
      packet(1, 'echo', { text: '' }),
      packet(2, 'hello', { protocolMajor: 99, protocolMinor: 0 }),
    ]);
    assert.deepEqual(
      before.map((v) => (v as { error: { code: number } }).error.code),
      [-32002, -32001],
    );
    for (const wire of [
      'Content-Length: 65537\r\n\r\n',
      'x'.repeat(1025),
      'Content-Length: -1\r\n\r\n',
      'Content-Length: 2\r\n\r\n{',
      'Content-Length: 1\r\n\r\nx',
    ])
      assert.deepEqual(await raw([Buffer.from(wire)]), []);
    assert.deepEqual(
      await raw([Buffer.concat([Buffer.from('Content-Length: 1\r\n\r\n'), Buffer.from([255])])]),
      [],
    );
  },
);
test('real Rust schemas and busy bound reject invalid requests', { timeout: 6000 }, async () => {
  const inputs = [
    hello,
    packet(2, 'unknown', {}),
    packet(3, 'echo', { text: 'x', extra: 1 }),
    packet(4, 'echo', { text: '한'.repeat(2731) }),
    packet(5, 'delay', { text: '', delayMs: 1.5 }),
  ];
  for (let id = 6; id <= 22; id++) inputs.push(packet(id, 'delay', { text: '', delayMs: 10000 }));
  inputs.push(packet(23, 'shutdown', {}));
  const frames = await raw(inputs);
  const errors = frames.filter((v) => 'error' in (v as object)) as {
    id: number;
    error: { code: number };
  }[];
  assert.ok(errors.some((v) => v.id === 22 && v.error.code === -32003));
  assert.ok(errors.some((v) => v.error.code === -32601));
  assert.equal(errors.filter((v) => v.error.code === -32602).length, 3);
});
test('SIGKILL parent closes partial-frame stdin and Rust exits', { timeout: 6000 }, async () => {
  const parent = spawn(process.execPath, [resolve('dist/tests/parentFixture.js'), binary], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  parent.stderr.resume();
  const [chunk] = await once(parent.stdout, 'data');
  const pid = Number(String(chunk).trim());
  assert.ok(pid > 0);
  const closed = once(parent, 'close');
  parent.kill('SIGKILL');
  await closed;
  await gone(pid);
});

test(
  'blocked fake reader and rapid cancellation keep outbound queue bounded',
  { timeout: 6000 },
  async () => {
    const client = new BridgeClient(process.execPath, [fixture, 'blocked']);
    await client.start();
    const pid = client.pid!;
    const requests: Promise<unknown>[] = [];
    let maxQueued = 0;
    for (let i = 0; i < 100; i++) {
      const controller = new AbortController();
      requests.push(
        client
          .request(
            'delay',
            { text: 'x'.repeat(8192), delayMs: 10000 },
            { signal: controller.signal },
          )
          .catch(() => undefined),
      );
      controller.abort();
      maxQueued = Math.max(maxQueued, client.diagnostics.queuedWrites);
    }
    assert.ok(maxQueued <= 32);
    await Promise.all(requests);
    await client.stop();
    await gone(pid);
  },
);
test('real duplicate pending ID is rejected once and original delay is discarded', async () => {
  const frames = await raw([
    hello,
    packet(2, 'delay', { text: '', delayMs: 10000 }),
    packet(2, 'delay', { text: '', delayMs: 0 }),
    packet(3, 'shutdown', {}),
  ]);
  assert.equal(frames.filter((value) => (value as { id: number }).id === 2).length, 1);
});

test(
  'actual Rust completion and cancellation settle exactly once in both orders and contention',
  { timeout: 10000 },
  async () => {
    const client = new BridgeClient(binary);
    await client.start();
    try {
      for (const order of ['cancel-first', 'complete-first', 'contended']) {
        for (let iteration = 0; iteration < 12; iteration++) {
          const controller = new AbortController();
          let settlements = 0;
          const text = `${order}-${iteration}`;
          const terminal = client
            .request(
              'delay',
              { text, delayMs: order === 'contended' ? 1 : 0 },
              { signal: controller.signal },
            )
            .then(
              (value) => {
                settlements++;
                return { kind: 'success', value };
              },
              (error: unknown) => {
                settlements++;
                return { kind: 'cancelled', error };
              },
            );
          if (order === 'cancel-first') controller.abort();
          let outcome;
          if (order === 'complete-first') {
            outcome = await terminal;
            await sleep(1);
            controller.abort();
          } else if (order === 'contended') {
            await sleep(1);
            controller.abort();
            outcome = await terminal;
          } else outcome = await terminal;
          await sleep(3);
          assert.equal(settlements, 1);
          assert.equal(client.diagnostics.pending, 0);
          if (order === 'cancel-first') assert.equal(outcome.kind, 'cancelled');
          if (order === 'complete-first') assert.equal(outcome.kind, 'success');
          if ('error' in outcome) assert.match(String(outcome.error), /Cancelled/);
          else assert.deepEqual(outcome.value, { text });
          assert.deepEqual(await client.request('echo', { text: `after-${text}` }), {
            text: `after-${text}`,
          });
        }
      }
    } finally {
      await client.stop();
    }
  },
);
