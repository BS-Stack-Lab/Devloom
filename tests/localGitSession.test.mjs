import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { launchOwned, probeProcess, groupMembers } from '../scripts/localGitSession.mjs';
const parent = process.env.DEVLOOM_EVIDENCE_DIR;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(inspect, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (inspect()) return;
    await delay(25);
  }
  throw new Error('FIXTURE_WAIT_TIMEOUT');
}
function fixture() {
  assert.ok(parent, 'Set external DEVLOOM_EVIDENCE_DIR');
  const directory = realpathSync(mkdtempSync(join(parent, 'lifecycle-unit-'))),
    nonce = randomBytes(16).toString('hex'),
    sessionId = randomUUID();
  const temporary = realpathSync(mkdtempSync('/tmp/dlg-unit-')),
    profile = join(temporary, `p-${nonce}`);
  mkdirSync(profile, { mode: 0o700 });
  writeFileSync(join(profile, 'preserved'), 'profile bytes', { flag: 'wx', mode: 0o600 });
  return {
    directory,
    temporary,
    profile,
    nonce,
    sessionId,
    sourceRoot: realpathSync(process.cwd()),
    evidence: directory,
    fixtureRoot: temporary,
  };
}
async function sentinel(f) {
  const nonce = randomBytes(16).toString('hex'),
    profile = join(f.temporary, `sentinel-${nonce}`);
  mkdirSync(profile);
  writeFileSync(join(profile, 'bytes'), 'INDEPENDENT SENTINEL', { mode: 0o600 });
  const marker = { nonce, profile },
    markerPath = join(profile, 'marker.json');
  writeFileSync(markerPath, JSON.stringify(marker), { mode: 0o600 });
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(()=>{},1000)', '--', `--user-data-dir=${profile}`],
    { detached: true, stdio: 'ignore' },
  );
  const closure = new Promise((done) => child.once('close', done));
  const initial = probeProcess(child.pid);
  writeFileSync(
    join(f.directory, 'sentinel-initial.json'),
    JSON.stringify({ initial, nonce, profile, markerPath, marker }),
    { mode: 0o600 },
  );
  return {
    child,
    profile,
    initial,
    closure,
    verify() {
      const current = probeProcess(child.pid);
      assert.equal(current.startIdentity, initial.startIdentity);
      assert.equal(current.detachedPgid, child.pid);
      assert.equal(readFileSync(join(profile, 'bytes'), 'utf8'), 'INDEPENDENT SENTINEL');
      assert.equal(readFileSync(markerPath, 'utf8'), JSON.stringify(marker));
    },
  };
}
async function ownerTeardown(host, s, f) {
  let error;
  try {
    if (host && !host.state.closed) {
      host.child.kill('SIGKILL');
      await until(() => groupMembers(host.child.pid).length === 0);
    }
    s?.verify();
  } catch (caught) {
    error = caught;
  } finally {
    if (s) {
      s.child.kill('SIGTERM');
      await s.closure;
    }
    writeFileSync(
      join(f.directory, 'test-owner-teardown.json'),
      JSON.stringify({
        actor: 'test-owner',
        launcherRetry: false,
        at: Date.now(),
        error: error?.message,
      }),
      { mode: 0o600 },
    );
    if (!error) rmSync(f.temporary, { recursive: true, force: true });
  }
  if (error) throw error;
}

function launch(f, options = {}) {
  const script =
    options.script ??
    `require('fs').writeFileSync(${JSON.stringify(join(f.temporary, 'ready'))},'ready');setInterval(()=>{},1000)`;
  return launchOwned({
    ...f,
    command: process.execPath,
    args: ['-e', script, '--', `--user-data-dir=${f.profile}`],
    cwd: f.temporary,
    env: process.env,
    timeoutMs: 5000,
    ...options,
  });
}
test('real ENOENT and EACCES spawn failures retain undefined PID and never signal', async () => {
  for (const code of ['ENOENT', 'EACCES']) {
    const f = fixture(),
      s = await sentinel(f);
    let host;
    try {
      const command = join(f.temporary, 'nonexecutable');
      if (code === 'EACCES') {
        writeFileSync(command, 'not executable');
        chmodSync(command, 0o600);
      }
      host = launch(f, { command, timeoutMs: 1000 });
      const result = await host.completion;
      assert.equal(result.pid, null);
      assert.equal(result.status, 'fail');
      assert.equal(result.terminationAttempts.length, 0);
      assert.ok(result.events.some((event) => event.type === 'error' && event.code === code));
      assert.ok(result.finalized);
      assert.ok(result.cleanup.leftovers.includes(f.profile));
      s.verify();
    } finally {
      await ownerTeardown(host, s, f);
    }
  }
});
test('actual nonzero exit and actual signal exit cannot become pass after cleanup', async () => {
  for (const mode of ['nonzero', 'signal']) {
    const f = fixture(),
      s = await sentinel(f);
    let host;
    try {
      host = launch(f, {
        script:
          mode === 'nonzero'
            ? 'setTimeout(()=>process.exit(7),150)'
            : 'setTimeout(()=>process.kill(process.pid,"SIGTERM"),150)',
      });
      const result = await host.completion;
      assert.equal(result.status, 'fail');
      assert.equal(result.code, mode === 'nonzero' ? 7 : null);
      assert.equal(result.signal, mode === 'signal' ? 'SIGTERM' : null);
      assert.ok(result.finalization.timerCleared);
      assert.ok(result.cleanup.confirmedClosed);
      s.verify();
    } finally {
      await ownerTeardown(host, s, f);
    }
  }
});
test('actual short owned timeout and injected asynchronous live-child error remain failed', async () => {
  for (const injection of [false, true]) {
    const f = fixture(),
      s = await sentinel(f);
    let host;
    try {
      host = launch(f, {
        timeoutMs: 250,
        onChild: injection
          ? (child) =>
              setTimeout(
                () =>
                  child.emit(
                    'error',
                    Object.assign(new Error('injected live child error'), {
                      code: 'INJECTED_LIVE_ERROR',
                    }),
                  ),
                30,
              )
          : undefined,
      });
      const result = await host.completion;
      assert.equal(result.status, 'fail');
      assert.ok(result.timedOut);
      assert.ok(result.terminationAttempts.some((a) => a.disposition === 'sent'));
      assert.ok(result.closed);
      assert.ok(result.cleanup.confirmedClosed);
      if (injection) assert.equal(result.firstError, 'INJECTED_LIVE_ERROR');
      s.verify();
    } finally {
      await ownerTeardown(host, s, f);
    }
  }
});
const fields = ['uid', 'pid', 'startIdentity', 'detachedPgid', 'nonce'];
for (const phase of ['SIGTERM', 'SIGKILL'])
  for (const field of fields)
    for (const mutation of ['changed', 'missing'])
      test(`real live child ${phase} ${field} ${mutation} rejection preserves group and sentinel`, async () => {
        const f = fixture(),
          s = await sentinel(f);
        let host;
        try {
          host = launch(f, {
            script: `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(join(f.temporary, 'ready'))},'ready');setInterval(()=>{},1000)`,
            authorizationProbe: (observed, signal) => {
              if (signal !== phase) return observed;
              const changed = { ...observed };
              if (mutation === 'missing') delete changed[field];
              else
                changed[field] =
                  typeof changed[field] === 'number'
                    ? changed[field] + 1
                    : changed[field] + '-changed';
              return changed;
            },
          });
          await until(() => existsSync(join(f.temporary, 'ready')));
          assert.equal(await host.terminate(), false);
          const sent = host.state.terminationAttempts.filter((a) => a.disposition === 'sent');
          assert.deepEqual(
            sent.map((a) => a.signal),
            phase === 'SIGTERM' ? [] : ['SIGTERM'],
          );
          assert.equal(host.state.ownership, 'ambiguous');
          assert.equal(host.state.status, 'fail');
          assert.equal(probeProcess(host.child.pid).pid, host.child.pid);
          assert.ok(host.state.cleanup.leftovers.includes(f.profile));
          assert.ok(existsSync(f.profile));
          s.verify();
        } finally {
          await ownerTeardown(host, s, f);
        }
      });
for (const failure of [
  'stale-sequence',
  'missing-marker',
  'replaced-marker',
  'foreign-marker',
  'stale-marker',
  'malformed-ps',
  'failed-ps',
  'capture-failure',
])
  test(`actual owned child rejects ${failure}`, async () => {
    const f = fixture(),
      s = await sentinel(f);
    let host;
    try {
      const options = {};
      if (failure === 'stale-sequence')
        options.authorizationProbe = (value) => ({ ...value, sequence: 0 });
      if (failure === 'malformed-ps') options.authorizationProbe = () => ({ bad: true });
      if (failure === 'failed-ps')
        options.authorizationProbe = () => {
          throw new Error('injected probe failure');
        };
      if (failure === 'capture-failure')
        options.initialProbe = () => {
          throw new Error('injected initial capture failure');
        };
      if (failure === 'foreign-marker')
        options.markerProbe = (value) => ({
          ...value,
          value: { ...value.value, uid: value.value.uid + 1 },
        });
      if (failure === 'stale-marker')
        options.markerProbe = (value) => ({ ...value, sha256: '0'.repeat(64) });
      host = launch(f, options);
      await until(() => existsSync(join(f.temporary, 'ready')));
      const marker = join(f.temporary, `.launch-${f.sessionId}.json`);
      if (failure === 'missing-marker') rmSync(marker);
      if (failure === 'replaced-marker') {
        rmSync(marker);
        writeFileSync(marker, '{}', { mode: 0o600 });
      }
      assert.equal(await host.terminate(), false);
      assert.equal(
        host.state.terminationAttempts.filter((a) => a.disposition === 'sent').length,
        0,
      );
      assert.equal(probeProcess(host.child.pid).pid, host.child.pid);
      s.verify();
    } finally {
      await ownerTeardown(host, s, f);
    }
  });
test('all-match real TERM-responsive leader and descendant close with independent sentinel intact', async () => {
  const f = fixture(),
    s = await sentinel(f);
  let host;
  try {
    host = launch(f, {
      script: `const {spawn}=require('child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.on('SIGTERM',()=>{child.once('exit',()=>process.exit(0));});require('fs').writeFileSync(${JSON.stringify(join(f.temporary, 'ready'))},String(child.pid));setInterval(()=>{},1000)`,
    });
    await until(() => existsSync(join(f.temporary, 'ready')));
    assert.ok(groupMembers(host.child.pid).length >= 2);
    assert.equal(await host.terminate(), true);
    const result = await host.completion;
    assert.deepEqual(
      result.terminationAttempts.filter((a) => a.disposition === 'sent').map((a) => a.signal),
      ['SIGTERM'],
    );
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.ok(result.closed);
    assert.deepEqual(groupMembers(host.child.pid), []);
    assert.ok(result.finalized);
    s.verify();
  } finally {
    await ownerTeardown(host, s, f);
  }
});
test('all-match real TERM-ignoring leader and descendant require separately authorized KILL and actual closure', async () => {
  const f = fixture(),
    s = await sentinel(f);
  let host;
  try {
    host = launch(f, {
      script: `const {spawn}=require('child_process');const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});process.on('SIGTERM',()=>{});setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(join(f.temporary, 'ready'))},String(child.pid)),100);setInterval(()=>{},1000)`,
    });
    await until(() => existsSync(join(f.temporary, 'ready')));
    assert.ok(groupMembers(host.child.pid).length >= 2);
    assert.equal(await host.terminate(), true);
    const result = await host.completion;
    assert.equal(result.status, 'fail');
    assert.equal(result.signal, 'SIGKILL');
    assert.deepEqual(
      result.terminationAttempts.filter((a) => a.disposition === 'sent').map((a) => a.signal),
      ['SIGTERM', 'SIGKILL'],
    );
    assert.ok(result.terminationAttempts[1].sequence > result.terminationAttempts[0].sequence);
    assert.deepEqual(groupMembers(host.child.pid), []);
    assert.ok(result.finalization.logClosed);
    s.verify();
  } finally {
    await ownerTeardown(host, s, f);
  }
});
test('absent leader with live descendant is ambiguous and receives no launcher signal', async () => {
  const f = fixture(),
    s = await sentinel(f);
  let host, descendant;
  try {
    host = launch(f, {
      script: `const {spawn}=require('child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(join(f.temporary, 'ready'))},String(child.pid));setTimeout(()=>process.exit(0),150)`,
    });
    await until(() => existsSync(join(f.temporary, 'ready')));
    descendant = Number(readFileSync(join(f.temporary, 'ready'), 'utf8'));
    await delay(250);
    assert.equal(await host.terminate(), false);
    const result = await host.completion;
    assert.equal(result.status, 'fail');
    assert.equal(result.ownership, 'ambiguous');
    assert.equal(result.terminationAttempts.filter((a) => a.disposition === 'sent').length, 0);
    assert.ok(groupMembers(host.child.pid).some((row) => row.pid === descendant));
    s.verify();
  } finally {
    if (descendant) {
      try {
        process.kill(descendant, 'SIGTERM');
      } catch {}
    }
    await ownerTeardown(host, s, f);
  }
});
