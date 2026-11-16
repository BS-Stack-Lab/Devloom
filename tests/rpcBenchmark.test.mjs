import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { BridgeClient } from '../dist/extensions/devloom-bootstrap/src/bridgeClient.js';
import {
  config,
  inputs,
  inputIdentities,
  configDigest,
  summarize,
  throughput,
  baselineEcho,
  runExperiment,
} from '../scripts/rpcBenchmark.mjs';
import {
  main,
  helperPath,
  parseRss,
  memoryBoundary,
  snapshotFiles,
  verifySnapshot,
} from '../scripts/runRpcBenchmark.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const small = {
  ...config,
  repetitions: 2,
  warmupCount: 2,
  measuredCount: 3,
  concurrency: [1, 16],
  deadlineMs: 3000,
};
const resultOf = () => ({
  cells: [],
  summaries: [],
  lifecycle: [],
  memory: [],
  cleanup: { attempted: false, completed: false, clientsStopped: 0 },
});
function syntheticClient(options = {}) {
  const pending = new Set();
  const client = {
    state: 'stopped',
    generation: 0,
    pid: undefined,
    stopCalls: 0,
    maximumPending: 0,
    get diagnostics() {
      return {
        state: this.state,
        generation: this.generation,
        pid: this.pid,
        pending: pending.size,
      };
    },
    async start() {
      this.state = 'ready';
      this.pid = 100 + ++this.generation;
      return {
        protocolMajor: 1,
        protocolMinor: 0,
        build: 'synthetic-test-only',
        features: ['echo', 'delay', 'cancel', 'shutdown'],
      };
    },
    request(method, params, requestOptions = {}) {
      if (method === 'echo')
        return Promise.resolve({ text: options.mismatch ? 'wrong' : params.text });
      return new Promise((_, reject) => {
        let timer;
        const finish = (code) => {
          if (!pending.delete(finish)) return;
          clearTimeout(timer);
          requestOptions.signal?.removeEventListener('abort', abort);
          reject(new Error(code));
        };
        const abort = () => finish(options.cancelCode ?? 'Cancelled');
        pending.add(finish);
        this.maximumPending = Math.max(this.maximumPending, pending.size);
        requestOptions.signal?.addEventListener('abort', abort, { once: true });
        if (requestOptions.timeoutMs)
          timer = setTimeout(
            () => finish(options.timeoutCode ?? 'Timeout'),
            requestOptions.timeoutMs,
          );
      });
    },
    async stop() {
      this.stopCalls++;
      for (const finish of [...pending]) finish('Stopped');
      this.pid = undefined;
      this.state = 'stopped';
      if (options.stopFailure) throw new Error('CleanupDeadline');
    },
    async restart() {
      await this.stop();
      return this.start();
    },
  };
  return client;
}
const capture = () => ({
  text: '',
  write(value) {
    this.text += value;
  },
});
const fixture = () => {
  const parent = process.env.DEVLOOM_EVIDENCE_DIR ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(resolve(parent, 'rpc-benchmark-synthetic-test-'));
  const repository = resolve(directory, 'repository');
  fs.mkdirSync(repository);
  return { directory, repository };
};
const runSynthetic = (options = {}, workload = small) => {
  const result = resultOf(),
    clients = [];
  const promise = runExperiment({
    result,
    workload,
    createClient: () => {
      const client = syntheticClient(options);
      clients.push(client);
      return client;
    },
  });
  return { result, clients, promise };
};

test('nearest rank uses raw sorted values without mutating observations', () => {
  for (const [values, p50Ms, p95Ms, maxMs] of [
    [[1], 1, 1, 1],
    [[4, 1, 3, 2], 2, 4, 4],
    [[0, 0, 0], 0, 0, 0],
    [[2, 1, 2, 2, 8], 2, 8, 8],
    [Array.from({ length: 100 }, (_, i) => i), 49, 94, 99],
  ]) {
    const original = [...values];
    assert.deepEqual(summarize(values), {
      count: values.length,
      p50Ms,
      p95Ms,
      maxMs,
      estimator: 'nearest-rank',
    });
    assert.deepEqual(values, original);
  }
  for (const values of [[], [NaN], [Infinity], [-1], [undefined]])
    assert.throws(() => summarize(values), /invalid-samples/);
});
test('throughput derives from cell wall and explicitly handles timer resolution', () => {
  assert.deepEqual(throughput(100, 50), { throughputPerSecond: 2000 });
  assert.deepEqual(throughput(100, 0), {
    throughputPerSecond: null,
    throughputUnavailableReason: 'nonpositive-wall-duration',
  });
  for (const [count, wall] of [
    [1, -1],
    [-1, 2],
    [1.2, 1],
    [1, NaN],
    [1, Infinity],
  ])
    assert.throws(() => throughput(count, wall), /invalid-cell/);
});
test('frozen workloads preserve exact UTF8 identities and total operation counts', async () => {
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.concurrency));
  assert.ok(Object.isFrozen(inputs));
  assert.ok(inputs.every(Object.isFrozen));
  assert.deepEqual(
    inputs.map((input) => input.text),
    ['', '한글 e\u0301 👩🏽‍💻\nRPC', 'x'.repeat(1024), 'x'.repeat(8192)],
  );
  assert.deepEqual(
    inputs.map((input) => input.bytes),
    [0, 30, 1024, 8192],
  );
  assert.deepEqual(
    inputIdentities,
    inputs.map(({ id, text }) => ({ id, bytes: Buffer.byteLength(text), sha256: sha(text) })),
  );
  assert.equal(configDigest, sha(JSON.stringify({ config, inputs: inputIdentities })));
  const cellCount = config.repetitions * inputs.length * config.concurrency.length * 2;
  assert.equal(cellCount * config.measuredCount, 8000);
  assert.equal(cellCount * config.warmupCount, 1600);
  assert.deepEqual(await baselineEcho(inputs[1].text), { text: inputs[1].text });
  await assert.rejects(baselineEcho('x'.repeat(8193)), /InvalidParams/);
});
test('synthetic lifecycle validates order, partial batches, raw summaries and cleanup', async () => {
  const { promise, result, clients } = runSynthetic();
  await promise;
  assert.equal(result.cells.length, 32);
  assert.equal(result.summaries.length, 16);
  assert.equal(result.lifecycle.length, 2);
  assert.deepEqual(result.cells[0].order, ['ts-only-in-process', 'rust-stdio']);
  assert.deepEqual(result.cells[16].order, ['rust-stdio', 'ts-only-in-process']);
  for (const cell of result.cells) {
    assert.equal(cell.latencyMs.length, 3);
    assert.equal(cell.completedCount, 3);
    assert.equal(cell.warmupCount, 2);
    assert.equal(cell.throughputPerSecond, 3000 / cell.wallMs);
  }
  for (const summary of result.summaries) {
    const raw = result.cells
      .filter(
        (cell) =>
          cell.mode === summary.mode &&
          cell.inputId === summary.inputId &&
          cell.concurrency === summary.concurrency,
      )
      .flatMap((cell) => cell.latencyMs);
    for (const [key, value] of Object.entries(summarize(raw))) assert.equal(summary[key], value);
  }
  assert.ok(clients.every((client) => client.state === 'stopped' && !client.pid));
  assert.equal(result.cleanup.clientsStopped, 2);
  assert.ok(
    result.lifecycle.every(
      (item) =>
        item.cancel.outcome === 'Cancelled' &&
        item.timeout.outcome === 'Timeout' &&
        item.stop.pendingOutcome === 'Stopped' &&
        item.restart.current.generation > item.restart.previous.generation,
    ),
  );
});
test('mismatch and unexpected cancellation or timeout fail and stop owned clients', async () => {
  for (const options of [
    { mismatch: true },
    { cancelCode: 'resolved' },
    { timeoutCode: 'wrong' },
  ]) {
    const { promise, clients, result } = runSynthetic(options);
    await assert.rejects(promise, /echo-mismatch|unexpected-cancellation|unexpected-timeout/);
    assert.ok(clients.every((client) => client.state === 'stopped' && client.stopCalls > 0));
    assert.equal(result.cleanup.completed, true);
  }
});
test('deadline settles in-flight startup before completing finally cleanup', async () => {
  const client = syntheticClient();
  let settled = false;
  client.start = async () => {
    await wait(40);
    settled = true;
    throw new Error('Stopped');
  };
  const result = resultOf();
  await assert.rejects(
    runExperiment({
      result,
      createClient: () => client,
      workload: { ...small, repetitions: 1, deadlineMs: 10 },
    }),
    /experiment-deadline/,
  );
  assert.equal(settled, true);
  assert.ok(client.stopCalls > 0);
  assert.equal(result.lifecycle.length, 0);
  assert.equal(result.cleanup.completed, true);
});
test('deadline crossing before batch admission dispatches no untracked operations', async () => {
  let ticks = 0,
    dispatched = 0;
  const payload = {
    ...inputs[0],
    get text() {
      dispatched++;
      return '';
    },
  };
  const result = resultOf();
  await assert.rejects(
    runExperiment({
      result,
      createClient: () => {
        throw new Error('must-not-start');
      },
      payloads: [payload],
      workload: { ...small, deadlineMs: 100 },
      clock: () => (++ticks >= 5 ? 100 : 0),
    }),
    /experiment-deadline/,
  );
  assert.equal(dispatched, 0);
  assert.equal(result.cells.length, 0);
});
test('cleanup failure remains failure with safe teardown evidence', async () => {
  const { promise, result } = runSynthetic({ mismatch: true, stopFailure: true });
  await assert.rejects(promise, /CleanupDeadline/);
  assert.equal(result.cleanup.completed, false);
  assert.equal(result.cleanup.errorCode, 'CleanupDeadline');
});
test('RSS parses one positive integer and records unavailable owned observations', () => {
  assert.deepEqual(parseRss('  123\n'), {
    originalValue: 123,
    originalUnit: '1024-byte-units',
    bytes: 125952,
  });
  for (const text of ['', '0', '-1', '1 2', '3\n4', 'NaN', '1.5', '9007199254740991'])
    assert.throws(() => parseRss(text), /invalid-rss/);
  const client = { state: 'ready', pid: 123, generation: 1 };
  const point = { phase: 'synthetic-test', repetition: 0, client };
  const records = memoryBoundary(point, (_executable, args, options) => {
    assert.deepEqual(args, ['-o', 'rss=', '-p', '123']);
    assert.equal(options.timeout, 2000);
    assert.equal(options.maxBuffer, 4096);
    return '23';
  });
  assert.equal(records[1].bytes, 23552);
  assert.equal(records[0].unit, 'bytes');
  for (const probe of [
    () => '',
    () => {
      throw new Error('timeout');
    },
    () => {
      client.generation++;
      return '23';
    },
  ]) {
    const sample = memoryBoundary(point, probe)[1];
    assert.equal(sample.available, false);
    assert.equal(sample.bytes, undefined);
  }
});
test('required identities refuse missing/symlink files and detect post-run drift', () => {
  const { directory } = fixture();
  fs.writeFileSync(resolve(directory, 'a'), 'one');
  const before = snapshotFiles(directory, ['a']);
  fs.writeFileSync(resolve(directory, 'a'), 'two');
  assert.throws(() => verifySnapshot(before, snapshotFiles(directory, ['a'])), /provenance-drift/);
  assert.throws(() => snapshotFiles(directory, ['missing']), /required-file-unavailable/);
  fs.symlinkSync(resolve(directory, 'a'), resolve(directory, 'alias'));
  assert.throws(() => snapshotFiles(directory, ['alias']), /required-file-unavailable/);
});
test('unsafe evidence and arguments are refused without preflight or execution', async () => {
  const { directory, repository } = fixture();
  fs.symlinkSync(repository, resolve(directory, 'repository-alias'));
  for (const [args, parent] of [
    [['--helper=anything'], directory],
    [[], undefined],
    [[], 'relative'],
    [[], repository],
    [[], resolve(directory, 'repository-alias')],
  ]) {
    let executed = false;
    const stderr = capture();
    assert.equal(
      await main(
        args,
        { DEVLOOM_EVIDENCE_DIR: parent },
        {
          repository,
          stderr,
          preflight: () => {
            executed = true;
          },
        },
      ),
      1,
    );
    assert.equal(executed, false);
    assert.match(stderr.text, /errorCode/);
  }
});
test('allocated failures preserve exclusive raw evidence and existing sentinel bytes', async () => {
  const { directory, repository } = fixture();
  const sentinel = resolve(directory, 'sentinel');
  fs.writeFileSync(sentinel, 'keep');
  const paths = [];
  for (const stage of ['preflight', 'measurement', 'provenance']) {
    const stdout = capture();
    const code = await main(
      [],
      { DEVLOOM_EVIDENCE_DIR: directory },
      {
        repository,
        stdout,
        evidenceKind: 'synthetic-failure-test',
        preflight: () => {
          if (stage === 'preflight') throw new Error('required-file-unavailable');
          return { synthetic: true, fileHashes: [] };
        },
        experiment: async ({ result, record }) => {
          record({ kind: 'synthetic-test', stage });
          if (stage === 'measurement') throw new Error('secret-must-not-escape');
          result.cleanup.completed = true;
        },
        verify: () => {
          throw new Error('provenance-drift');
        },
      },
    );
    assert.equal(code, 1);
    const { path } = JSON.parse(stdout.text);
    paths.push(path);
    const reportText = fs.readFileSync(path, 'utf8'),
      report = JSON.parse(reportText);
    assert.equal(report.outcome, 'failed');
    assert.equal(report.memoryCoverage, 'incomplete');
    assert.equal(report.completedCellCount, 0);
    assert.doesNotMatch(reportText, /secret-must-not-escape/);
    const raw = fs.readFileSync(report.session.rawPath);
    assert.equal(report.session.rawSha256, sha(raw));
    assert.equal(raw.toString().trim().split('\n').length, report.session.rawRecordCount);
    assert.equal(fs.statSync(path).mode & 0o777, 0o600);
    assert.equal(fs.statSync(report.session.rawPath).mode & 0o777, 0o600);
    assert.match(raw.toString(), /synthetic-failure-test/);
  }
  assert.equal(new Set(paths).size, 3);
  assert.ok(paths.every(fs.existsSync));
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
});
test('actual fixed Rust bridge smoke captures real cells, lifecycle and boundary RSS', async () => {
  const result = resultOf();
  await runExperiment({
    result,
    workload: { ...small, repetitions: 1 },
    createClient: () => new BridgeClient(helperPath),
    boundary: memoryBoundary,
  });
  assert.equal(result.cells.length, 16);
  assert.equal(result.lifecycle.length, 1);
  assert.equal(result.cleanup.completed, true);
  assert.notEqual(result.lifecycle[0].start.hello.build, 'synthetic-test-only');
  assert.ok(result.memory.some((item) => item.process === 'helper'));
  assert.ok(result.cells.every((cell) => cell.latencyMs.length === 3));
  assert.equal(result.lifecycle[0].stop.pid, null);
  assert.equal(result.lifecycle[0].stop.pending, 0);
});
