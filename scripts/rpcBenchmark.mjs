import { performance } from 'node:perf_hooks';
import { setTimeout as wait } from 'node:timers/promises';
import { digest } from './componentInventoryFiles.mjs';
import {
  validateParams,
  validateResult,
} from '../dist/extensions/devloom-bootstrap/src/protocol.js';

export const config = Object.freeze({
  repetitions: 5,
  warmupCount: 20,
  measuredCount: 100,
  concurrency: Object.freeze([1, 16]),
  deadlineMs: 60000,
  scheduling: 'sequential-batches-with-final-partial-batch',
  latencyBoundary: 'before-dispatch-through-common-result-validation-and-equality-check',
  estimator: 'nearest-rank',
});
export const inputs = Object.freeze(
  [
    ['empty', ''],
    ['unicode', '한글 e\u0301 👩🏽‍💻\nRPC'],
    ['ascii-1024', 'x'.repeat(1024)],
    ['ascii-8192', 'x'.repeat(8192)],
  ].map(([id, text]) =>
    Object.freeze({ id, text, bytes: Buffer.byteLength(text), sha256: digest(text) }),
  ),
);
export const inputIdentities = inputs.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 }));
export const configDigest = digest(JSON.stringify({ config, inputs: inputIdentities }));
export const limitations = [
  'Node JavaScript in-process echo using compiled TypeScript validators versus actual debug Rust stdio architectural cost; no language speedup claim.',
  'No renderer, extension host, Electron UI blocking, GitHub latency, native UI, packaging or overall P0 acceptance measurement.',
  'Sequential batches; shared runner V8/JIT/GC, caches, load and retained samples affect both modes. Fresh helper process does not mean cold OS caches.',
  'Cancellation measures local promise settlement, not remote acknowledgement or completion; health echo proves responsiveness only.',
  'RSS boundary observations are not peaks, isolated per-mode allocations, process-tree or total IDE memory; incomplete samples forbid a memory comparison.',
  'Client lifetime envelopes span owned generations, not exact OS process CPU lifetime. TS startup/restart/lifetime are not applicable.',
  'Five local repetitions and no performance threshold; local-byte hashes are not reproducible-build attestation.',
];
export function summarize(samples) {
  if (!samples.length || samples.some((n) => !Number.isFinite(n) || n < 0))
    throw new Error('invalid-samples');
  const sorted = [...samples].sort((a, b) => a - b);
  const quantile = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return {
    count: sorted.length,
    p50Ms: quantile(0.5),
    p95Ms: quantile(0.95),
    maxMs: sorted.at(-1),
    estimator: 'nearest-rank',
  };
}
export function throughput(count, wallMs) {
  if (!Number.isInteger(count) || count < 0 || !Number.isFinite(wallMs) || wallMs < 0)
    throw new Error('invalid-cell');
  return wallMs > 0
    ? { throughputPerSecond: (count * 1000) / wallMs }
    : { throughputPerSecond: null, throughputUnavailableReason: 'nonpositive-wall-duration' };
}
export async function baselineEcho(text) {
  validateParams('echo', { text });
  return { text };
}
export function safeError(error) {
  const code = error?.message;
  return new Set([
    'experiment-deadline',
    'echo-mismatch',
    'invalid-samples',
    'invalid-cell',
    'unexpected-cancellation',
    'unexpected-timeout',
    'unexpected-stop',
    'invalid-lifecycle',
    'CleanupDeadline',
    'source-provenance-failed',
    'required-file-unavailable',
    'provenance-drift',
    'unsupported-host',
    'toolchain-mismatch',
    'unsupported-cli-argument',
    'evidence-parent-required',
    'output-inside-repository',
    'invalid-rss',
  ]).has(code)
    ? code
    : 'benchmark-failed';
}
export async function runExperiment({
  createClient,
  result,
  record = () => {},
  boundary = () => [],
  clock = () => performance.now(),
  workload = config,
  payloads = inputs,
}) {
  const deadline = clock() + workload.deadlineMs;
  let timer, client;
  const outstanding = new Set();
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('experiment-deadline')), workload.deadlineMs);
  });
  expired.catch(() => {});
  const checkDeadline = () => {
    if (clock() >= deadline) throw new Error('experiment-deadline');
  };
  const bounded = async (operation) => {
    checkDeadline();
    const task = Promise.resolve().then(operation);
    outstanding.add(task);
    task.then(
      () => outstanding.delete(task),
      () => outstanding.delete(task),
    );
    const value = await Promise.race([task, expired]);
    checkDeadline();
    return value;
  };
  const emit = (kind, value) => {
    result[kind].push(value);
    record({ kind, ...value });
  };
  const sample = (phase, repetition) => {
    checkDeadline();
    for (const value of boundary({ phase, repetition, client })) emit('memory', value);
    checkDeadline();
  };
  const echo = async (mode, text) => {
    const value = await (mode === 'ts-only-in-process'
      ? baselineEcho(text)
      : client.request('echo', { text }));
    validateResult('echo', value);
    if (value.text !== text) throw new Error('echo-mismatch');
  };
  const batch = async (mode, input, concurrency, count, measured) => {
    const samples = [];
    for (let offset = 0; offset < count; offset += concurrency) {
      checkDeadline();
      const values = await bounded(() => {
        const tasks = Array.from({ length: Math.min(concurrency, count - offset) }, async () => {
          const start = clock();
          await echo(mode, input.text);
          return clock() - start;
        });
        return Promise.all(tasks);
      });
      if (measured) samples.push(...values);
    }
    return samples;
  };
  const cells = async (mode, repetition, order) => {
    for (const input of payloads)
      for (const concurrency of workload.concurrency) {
        result.stage = `echo-${mode}`;
        await batch(mode, input, concurrency, workload.warmupCount, false);
        const start = clock();
        const latencyMs = await batch(mode, input, concurrency, workload.measuredCount, true);
        const wallMs = clock() - start;
        emit('cells', {
          repetition,
          mode,
          inputId: input.id,
          inputSha256: input.sha256,
          bytes: input.bytes,
          concurrency,
          order,
          warmupCount: workload.warmupCount,
          completedCount: latencyMs.length,
          wallMs,
          ...throughput(latencyMs.length, wallMs),
          latencyMs,
        });
      }
  };
  const healthy = async () => {
    await bounded(() => echo('rust-stdio', 'health'));
    if (client.diagnostics.pending !== 0) throw new Error('invalid-lifecycle');
  };
  try {
    for (let repetition = 0; repetition < workload.repetitions; repetition++) {
      const order =
        repetition % 2 === 0
          ? ['ts-only-in-process', 'rust-stdio']
          : ['rust-stdio', 'ts-only-in-process'];
      const lifecycle = { repetition, order, tsLifecycle: 'not-applicable' };
      for (const mode of order) {
        if (mode === 'ts-only-in-process') {
          sample('before-baseline', repetition);
          await cells(mode, repetition, order);
          sample('after-baseline', repetition);
          continue;
        }
        result.stage = 'start';
        sample('before-rust-start', repetition);
        client = createClient();
        const envelopeStart = clock();
        const hello = await bounded(() => client.start());
        const readyAt = clock();
        lifecycle.start = { durationMs: readyAt - envelopeStart, hello, ...client.diagnostics };
        if (client.state !== 'ready' || client.diagnostics.pending !== 0)
          throw new Error('invalid-lifecycle');
        sample('after-hello', repetition);
        await cells(mode, repetition, order);
        sample('after-rust-echo', repetition);
        result.stage = 'cancel';
        const controller = new AbortController();
        const dispatch = clock();
        const cancellation = client
          .request(
            'delay',
            { text: 'cancel', delayMs: 1000 },
            {
              signal: controller.signal,
            },
          )
          .then(
            () => 'resolved',
            (error) => error.message,
          );
        await bounded(() => wait(20));
        const abortAt = clock();
        controller.abort();
        const cancelCode = await bounded(() => cancellation);
        lifecycle.cancel = {
          durationMs: clock() - abortAt,
          dispatchToAbortMs: abortAt - dispatch,
          outcome: cancelCode,
          remoteAcknowledgement: 'unavailable-local-settlement-only',
        };
        if (cancelCode !== 'Cancelled') throw new Error('unexpected-cancellation');
        await healthy();
        result.stage = 'timeout';
        const timeoutAt = clock();
        const timeoutCode = await bounded(() =>
          client.request('delay', { text: 'timeout', delayMs: 1000 }, { timeoutMs: 5 }).then(
            () => 'resolved',
            (error) => error.message,
          ),
        );
        lifecycle.timeout = { durationMs: clock() - timeoutAt, outcome: timeoutCode };
        if (timeoutCode !== 'Timeout') throw new Error('unexpected-timeout');
        await healthy();
        result.stage = 'restart';
        const previous = { ...client.diagnostics };
        const restartAt = clock();
        const restartHello = await bounded(() => client.restart());
        const restartedAt = clock();
        lifecycle.restart = {
          durationMs: restartedAt - restartAt,
          previous,
          current: { ...client.diagnostics },
          hello: restartHello,
          previousReadyToRestartCallMs: restartAt - readyAt,
        };
        if (
          client.generation <= previous.generation ||
          client.state !== 'ready' ||
          client.diagnostics.pending !== 0
        )
          throw new Error('invalid-lifecycle');
        await healthy();
        result.stage = 'stop';
        const pending = client.request('delay', { text: 'stop', delayMs: 1000 }).then(
          () => 'resolved',
          (error) => error.message,
        );
        const stopAt = clock();
        await bounded(() => client.stop());
        const stoppedAt = clock();
        const stoppedCode = await bounded(() => pending);
        lifecycle.stop = {
          durationMs: stoppedAt - stopAt,
          pendingOutcome: stoppedCode,
          ...client.diagnostics,
          pid: client.pid ?? null,
          restartedReadyToStopCallMs: stopAt - restartedAt,
        };
        lifecycle.clientLifetimeEnvelopeMs = stoppedAt - envelopeStart;
        if (stoppedCode !== 'Stopped') throw new Error('unexpected-stop');
        if (
          client.state !== 'stopped' ||
          client.pid !== undefined ||
          client.diagnostics.pending !== 0
        )
          throw new Error('invalid-lifecycle');
        sample('after-stop', repetition);
        emit('lifecycle', lifecycle);
        result.cleanup.attempted = true;
        await client.stop();
        result.cleanup.completed = true;
        result.cleanup.clientsStopped++;
        client = undefined;
      }
    }
    const groups = new Map();
    for (const cell of result.cells) {
      const key = JSON.stringify([cell.mode, cell.inputId, cell.concurrency]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(...cell.latencyMs);
    }
    result.summaries = [...groups].map(([key, values]) => {
      const [mode, inputId, concurrency] = JSON.parse(key);
      return { mode, inputId, concurrency, ...summarize(values) };
    });
  } finally {
    clearTimeout(timer);
    if (client) {
      result.cleanup.attempted = true;
      result.cleanup.completed = false;
      try {
        await client.stop();
        result.cleanup.completed = true;
        result.cleanup.clientsStopped++;
      } catch (error) {
        result.cleanup.errorCode = safeError(error);
        throw error;
      } finally {
        await Promise.allSettled([...outstanding]);
      }
    }
  }
}
