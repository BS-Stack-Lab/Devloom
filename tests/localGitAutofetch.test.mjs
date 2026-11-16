import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
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
