import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { setImmediate as flush } from 'node:timers/promises';
const { completedAutofetch, awaitAutofetch, diagnosticEvents } = createRequire(import.meta.url)(
  '../dist/tests/localGitAutofetch.js',
);
const start = { event: 'child-start', at: 100, pid: 123, command: 'fetch' },
  close = { event: 'child-close', at: 200, pid: 123, command: 'fetch' };
test('new same-PID fetch start and close after release is required', () => {
  assert.deepEqual(completedAutofetch([start, close], [], 100, 150), { start, close });
  for (const events of [
    [start],
    [close],
    [{ ...start, at: 99 }, close],
    [start, { ...close, pid: 124 }],
    [start, { ...close, at: 140 }],
  ])
    assert.equal(completedAutofetch(events, [], 100, 150), undefined);
  assert.equal(completedAutofetch([start, close], [start], 100, 150), undefined);
});
test('nested diagnostic event collection retains actual records', () => {
  assert.deepEqual(diagnosticEvents({ coordinator: { events: [start, close] } }), [start, close]);
});
test('bounded waits do not pass while unfocused, interrupted or without close', async () => {
  for (const [focused, events] of [
    [false, [start, close]],
    [true, [start]],
  ])
    await assert.rejects(
      awaitAutofetch({
        before: [],
        enabledAt: 100,
        releasedAt: 150,
        focused: () => focused,
        inspect: async () => ({ events }),
        timeoutMs: 60,
      }),
      /TIMEOUT/,
    );
  await assert.rejects(
    awaitAutofetch({
      before: [],
      enabledAt: 100,
      releasedAt: 150,
      focused: () => true,
      inspect: async () => ({ events: [start, close] }),
      interrupted: () => true,
    }),
    /INTERRUPTED/,
  );
});
test('delayed focus and delayed close settle only after both actual observations', async () => {
  let attempt = 0;
  const value = await awaitAutofetch({
    before: [],
    enabledAt: 100,
    releasedAt: 150,
    focused: () => attempt >= 3,
    inspect: async () => ({
      coordinator: { coordinator: { state: 'ready' } },
      events: ++attempt < 2 ? [start] : [start, close, { event: 'released', at: 201 }],
    }),
    timeoutMs: 1000,
  });
  assert.ok(value.samples.length >= 3);
  assert.equal(value.close.pid, start.pid);
});

test('close alone cannot pass before operation release and coordinator readiness', async () => {
  await assert.rejects(
    awaitAutofetch({
      before: [],
      enabledAt: 100,
      releasedAt: 150,
      focused: () => true,
      inspect: async () => ({
        coordinator: { coordinator: { state: 'active' } },
        events: [start, close],
      }),
      timeoutMs: 60,
    }),
    /TIMEOUT/,
  );
});

test('foreign flat diagnostic shape cannot satisfy the actual nested coordinator contract', async () => {
  await assert.rejects(
    awaitAutofetch({
      before: [],
      enabledAt: 100,
      releasedAt: 150,
      focused: () => true,
      inspect: async () => ({
        coordinator: { state: 'ready' },
        events: [start, close, { event: 'released', at: 201 }],
      }),
      timeoutMs: 60,
    }),
    /TIMEOUT/,
  );
});

const activeTimers = () =>
  process.getActiveResourcesInfo().filter((type) => type === 'Timeout').length;
const completedDiagnostic = {
  coordinator: { coordinator: { state: 'ready' } },
  events: [start, close, { event: 'released', at: 201 }],
};
const pendingOptions = { before: [], enabledAt: 100, releasedAt: 150, focused: () => true };
test(
  'never-settling inspection times out within its own deadline and clears timers',
  { timeout: 1500 },
  async () => {
    const timers = activeTimers(),
      started = Date.now();
    await assert.rejects(
      awaitAutofetch({ ...pendingOptions, inspect: () => new Promise(() => {}), timeoutMs: 40 }),
      (error) => {
        assert.equal(error.message, 'AUTOFETCH_COMPLETION_TIMEOUT');
        assert.ok(error.diagnostics.elapsed >= 40);
        return true;
      },
    );
    assert.ok(Date.now() - started < 500);
    await flush();
    assert.equal(activeTimers(), timers);
  },
);
test(
  'interruption is observed while diagnostic inspection remains pending',
  { timeout: 1500 },
  async () => {
    const timers = activeTimers();
    let interrupted = false;
    const interrupt = setTimeout(() => {
      interrupted = true;
    }, 30);
    const started = Date.now();
    try {
      await assert.rejects(
        awaitAutofetch({
          ...pendingOptions,
          inspect: () => new Promise(() => {}),
          timeoutMs: 1000,
          interrupted: () => interrupted,
        }),
        /AUTOFETCH_INTERRUPTED/,
      );
      assert.ok(Date.now() - started < 500);
    } finally {
      clearTimeout(interrupt);
    }
    await flush();
    assert.equal(activeTimers(), timers);
  },
);
for (const outcome of ['resolve', 'reject'])
  test(
    `late inspection ${outcome} cannot pass or produce an unhandled rejection`,
    { timeout: 1500 },
    async () => {
      let resolveInspect,
        rejectInspect,
        passes = 0;
      const unhandled = [];
      const inspect = new Promise((resolve, reject) => {
        resolveInspect = resolve;
        rejectInspect = reject;
      });
      const listener = (error) => unhandled.push(error);
      process.on('unhandledRejection', listener);
      const timers = activeTimers();
      try {
        const observation = awaitAutofetch({
          ...pendingOptions,
          inspect: () => inspect,
          timeoutMs: 30,
        }).then((value) => {
          passes++;
          return value;
        });
        await assert.rejects(observation, /AUTOFETCH_COMPLETION_TIMEOUT/);
        if (outcome === 'resolve') resolveInspect(completedDiagnostic);
        else rejectInspect(new Error('late diagnostic rejection'));
        await flush();
        await flush();
        assert.equal(passes, 0);
        assert.deepEqual(unhandled, []);
        assert.equal(activeTimers(), timers);
      } finally {
        process.off('unhandledRejection', listener);
      }
    },
  );
test(
  'successful observation clears pending guard and polling timers',
  { timeout: 1500 },
  async () => {
    const timers = activeTimers();
    const value = await awaitAutofetch({
      ...pendingOptions,
      inspect: async () => completedDiagnostic,
      timeoutMs: 1000,
    });
    assert.equal(value.close.pid, start.pid);
    await flush();
    assert.equal(activeTimers(), timers);
  },
);

for (const [direction, adjustment] of [
  ['forward', 3600000],
  ['backward', -3600000],
])
  test(
    `pending inspection keeps its monotonic deadline after a ${direction} wall-clock jump`,
    { timeout: 1500, concurrency: false },
    async (t) => {
      const timers = activeTimers(),
        started = performance.now(),
        wallClock = Date.now;
      let inspected = false;
      const observation = awaitAutofetch({
        ...pendingOptions,
        timeoutMs: 100,
        inspect: () => {
          inspected = true;
          return new Promise(() => {});
        },
      });
      try {
        await flush();
        assert.equal(inspected, true);
        t.mock.method(Date, 'now', () => wallClock() + adjustment);
        await assert.rejects(observation, (error) => {
          assert.equal(error.message, 'AUTOFETCH_COMPLETION_TIMEOUT');
          assert.ok(error.diagnostics.elapsed >= 100);
          assert.ok(error.diagnostics.elapsed < 500);
          return true;
        });
        assert.ok(performance.now() - started >= 100);
        assert.ok(performance.now() - started < 500);
      } finally {
        t.mock.restoreAll();
      }
      assert.equal(Date.now, wallClock);
      await flush();
      assert.equal(activeTimers(), timers);
    },
  );
