import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { MutationBroker } from '../product/localGit/mutationBroker';
import { MutationClient, assertSpawn, track } from '../product/localGit/mutationClient';
import { capture } from '../product/localGit/snapshot';
import { encode, FrameDecoder } from '../extensions/devloom-bootstrap/src/framing';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture() {
  const root = mkdtempSync('/tmp/dlb-');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git(['init']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@invalid.local']);
  writeFileSync(join(repo, 'file'), 'base\n');
  git(['add', 'file']);
  git(['commit', '-m', 'base']);
  return { root, repo, git, endpoint: join(root, 'broker') };
}
test('actual child close fences release, queued stale request cannot change staged bytes', async () => {
  const f = fixture();
  const broker = new MutationBroker(f.endpoint);
  await broker.listen();
  const first = new MutationClient(f.endpoint);
  const second = new MutationClient(f.endpoint);
  try {
    const intent = capture(f.repo);
    let began = false;
    let closed = false;
    const one = first.run(intent, 'repository', async () => {
      began = true;
      const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},200)']);
      track(child);
      child.once('close', () => {
        closed = true;
      });
      writeFileSync(join(f.repo, 'file'), 'first\n');
      f.git(['add', 'file']);
    });
    while (!began) await delay(5);
    const two = second.run(intent, 'repository', async () => {
      throw new Error('Must never execute stale request');
    });
    await assert.rejects(two, /state changed/);
    await one;
    assert.deepEqual(
      {
        closed,
        staged: f.git(['show', ':file']).toString(),
        state: (await second.diagnose()).state,
      },
      { closed: true, staged: 'first\n', state: 'ready' },
    );
  } finally {
    await broker.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('same async chain reenters, unrelated promises queue and cross-key nesting refuses', async () => {
  const f = fixture();
  const broker = new MutationBroker(f.endpoint);
  await broker.listen();
  const client = new MutationClient(f.endpoint);
  try {
    const seen: string[] = [];
    let started = false;
    const first = client.run(capture(f.repo), 'repository', async () => {
      started = true;
      await client.run(capture(f.repo), 'repository', async () => {
        seen.push('nested');
      });
      await assert.rejects(
        client.run(capture(join(f.root, 'other'), 0, true), 'init', async () => {}),
        /across repositories/,
      );
      await delay(100);
      seen.push('first');
    });
    while (!started) await delay(5);
    const second = client.run(capture(f.repo), 'repository', async () => {
      seen.push('second');
    });
    await Promise.all([first, second]);
    assert.deepEqual(seen, ['nested', 'first', 'second']);
  } finally {
    await broker.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('transport owner death quarantines durable journal and survives broker restart', async () => {
  const f = fixture();
  let broker = new MutationBroker(f.endpoint);
  await broker.listen();
  try {
    const socket = createConnection(join(f.endpoint, 'broker.sock'));
    const granted = new Promise<void>((resolve) => {
      const decoder = new FrameDecoder();
      socket.on('data', (chunk: Buffer) => {
        if (decoder.push(chunk).length) resolve();
      });
    });
    socket.write(
      encode({
        version: 1,
        id: 'dead-owner',
        method: 'acquire',
        pid: process.pid,
        kind: 'repository',
        snapshot: capture(f.repo),
      }),
    );
    await granted;
    const journal = JSON.parse(readFileSync(join(f.endpoint, 'ownership.json'), 'utf8'));
    assert.equal(journal.record.state, 'active');
    socket.destroy();
    await delay(20);
    await broker.close();
    broker = new MutationBroker(f.endpoint);
    await broker.listen();
    await assert.rejects(
      new MutationClient(f.endpoint).run(capture(f.repo), 'repository', async () => {}),
      /quarantined/,
    );
    assert.equal(
      JSON.parse(readFileSync(join(f.endpoint, 'ownership.json'), 'utf8')).record.state,
      'quarantined',
    );
  } finally {
    await broker.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('malformed frames and foreign release cannot steal an active lease', async () => {
  const f = fixture();
  const broker = new MutationBroker(f.endpoint);
  await broker.listen();
  const client = new MutationClient(f.endpoint);
  try {
    let entered = false;
    const owner = client.run(capture(f.repo), 'repository', async () => {
      entered = true;
      await delay(100);
    });
    while (!entered) await delay(5);
    const socket = createConnection(join(f.endpoint, 'broker.sock'));
    const reply = new Promise<object>((resolve) => {
      const decoder = new FrameDecoder();
      socket.on('data', (chunk: Buffer) => {
        const messages = decoder.push(chunk);
        if (messages.length) resolve(messages[0] as object);
      });
    });
    socket.write(
      encode({ version: 1, id: 'thief', method: 'release', capability: 'wrong', clean: true }),
    );
    assert.match(JSON.stringify(await reply), /Invalid lease capability/);
    socket.end(Buffer.from('Content-Length: 65537\r\n\r\n'));
    await owner;
    assert.equal((await client.diagnose()).state, 'ready');
  } finally {
    await broker.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('unsafe endpoint and untrusted/unknown mutation fail before process execution', () => {
  const f = fixture();
  try {
    const alias = join(f.root, 'alias');
    symlinkSync(f.repo, alias);
    assert.throws(() => new MutationBroker(alias), /Unsafe/);
    assert.throws(() => assertSpawn(['status'], false), /Trust/);
    assert.throws(() => assertSpawn(['-c', 'a=b', 'fetch'], true), /coordinator|configuration/);
    assert.throws(
      () => assertSpawn(['config', '--global', '--add', 'safe.directory', f.repo], true),
      /Global/,
    );
    assert.equal(assertSpawn(['-c', 'i18n.logOutputEncoding=UTF-8', 'log', '-1'], true), true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('joining Main cannot rewrite a live ownership journal', async () => {
  const f = fixture();
  const broker = new MutationBroker(f.endpoint);
  await broker.listen();
  try {
    await new MutationClient(f.endpoint).run(capture(f.repo), 'repository', async () => {
      const before = readFileSync(join(f.endpoint, 'ownership.json'));
      const joining = new MutationBroker(f.endpoint);
      await assert.rejects(joining.listen(), /EADDRINUSE/);
      assert.deepEqual(readFileSync(join(f.endpoint, 'ownership.json')), before);
    });
  } finally {
    await broker.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('late async context cannot spawn or borrow a released lease', async () => {
  const f = fixture();
  const broker = new MutationBroker(f.endpoint);
  await broker.listen();
  try {
    const client = new MutationClient(f.endpoint);
    let check: Promise<void> = Promise.resolve();
    await client.run(capture(f.repo), 'repository', async () => {
      check = new Promise<void>((resolve, reject) =>
        setTimeout(() => {
          try {
            assert.throws(
              () => assertSpawn(['add', '--', 'file'], true),
              /coordinator|quarantined/,
            );
            client
              .run(capture(f.repo), 'repository', async () => {})
              .then(
                () => reject(new Error('Released context reused')),
                () => resolve(),
              );
          } catch (error) {
            reject(error);
          }
        }, 50),
      );
    });
    await check;
  } finally {
    await broker.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('Unicode HEAD and symbolic-ref write aliases retain correct boundaries', () => {
  const f = fixture();
  try {
    f.git(['checkout', '-b', '기능+검증']);
    assert.match(capture(f.repo).head, /기능\+검증/);
    for (const args of [
      ['symbolic-ref', '-d', 'HEAD'],
      ['branch', '--list', '--set-upstream-to=origin/main'],
      ['diff', '--output=/tmp/forbidden'],
    ])
      assert.throws(() => assertSpawn(args, true), /coordinator|Unsupported/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('nonempty corrupt ownership never becomes a clean restart', async () => {
  const f = fixture();
  mkdirSync(f.endpoint, { mode: 0o700 });
  writeFileSync(join(f.endpoint, 'ownership.json'), '{}', { mode: 0o600 });
  const broker = new MutationBroker(f.endpoint);
  try {
    await assert.rejects(broker.listen(), /Invalid Git ownership/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('clients reject unsafe endpoint permissions and symlink sockets', async () => {
  const f = fixture();
  const broker = new MutationBroker(f.endpoint);
  await broker.listen();
  try {
    chmodSync(f.endpoint, 0o755);
    await assert.rejects(new MutationClient(f.endpoint).diagnose(), /Unsafe/);
    chmodSync(f.endpoint, 0o700);
    const other = join(f.root, 'other-endpoint');
    mkdirSync(other, { mode: 0o700 });
    symlinkSync(join(f.endpoint, 'broker.sock'), join(other, 'broker.sock'));
    await assert.rejects(new MutationClient(other).diagnose(), /Unsafe/);
    assert.equal((await new MutationClient(f.endpoint).diagnose()).state, 'ready');
  } finally {
    await broker.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('reftable and nested symbolic branch refs fail closed instead of missing HEAD changes', () => {
  const f = fixture();
  try {
    execFileSync('git', ['init', '--ref-format=reftable', join(f.root, 'table')], {
      stdio: 'pipe',
    });
    assert.throws(() => capture(join(f.root, 'table')), /UnsupportedRefStorage/);
    const branch = f.git(['symbolic-ref', 'HEAD']).toString().trim();
    f.git(['symbolic-ref', 'refs/heads/alias', branch]);
    f.git(['symbolic-ref', 'HEAD', 'refs/heads/alias']);
    assert.throws(() => capture(f.repo), /Unsupported symbolic/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Unicode nonbreaking space at a branch end remains part of the HEAD identity', () => {
  const f = fixture();
  try {
    f.git(['checkout', '-b', 'topic\u00a0']);
    const nonbreaking = capture(f.repo);
    f.git(['checkout', '-b', 'topic']);
    const plain = capture(f.repo);
    assert.notEqual(nonbreaking.head, plain.head);
    f.git(['checkout', 'topic\u00a0']);
    f.git(['commit', '--allow-empty', '-m', 'new tip']);
    assert.notEqual(capture(f.repo).head, nonbreaking.head);
    assert.match(capture(f.repo).head, /topic\u00a0:/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
