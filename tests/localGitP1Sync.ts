import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { git, identity, snapshot } from './localGitFixtures';
import type { Context } from './localGitP1Host';
export async function sync(c: Context): Promise<void> {
  const create = async (name: string) => {
    const path = join(c.root, name);
    mkdirSync(path);
    git(path, ['init', '-b', 'main']);
    identity(path);
    writeFileSync(join(path, 'fixture.txt'), 'BASE\n');
    git(path, ['add', '.']);
    git(path, ['commit', '-m', 'base']);
    const repository = await c.api.openRepository(vscode.Uri.file(path));
    assert.ok(repository);
    await repository.status();
    return { path, repository };
  };
  const parents = (path: string) =>
    git(path, ['log', '-1', '--format=%P']).split(' ').filter(Boolean);
  const ff = await create('ff');
  git(ff.path, ['checkout', '-b', 'incoming']);
  writeFileSync(join(ff.path, 'fixture.txt'), 'FF\n');
  git(ff.path, ['commit', '-am', 'ff incoming']);
  const tip = git(ff.path, ['rev-parse', 'HEAD']);
  git(ff.path, ['checkout', 'main']);
  await ff.repository.status();
  const beforeFF = snapshot(ff.path);
  await ff.repository.merge('incoming');
  c.observe(
    'sync.ff',
    ff.repository,
    'merge',
    beforeFF,
    snapshot(ff.path),
    { head: tip, parents: 1 },
    { head: git(ff.path, ['rev-parse', 'HEAD']), parents: parents(ff.path).length },
  );
  const merge = await create('merge');
  git(merge.path, ['checkout', '-b', 'incoming']);
  writeFileSync(join(merge.path, 'incoming.txt'), 'INCOMING\n');
  git(merge.path, ['add', '.']);
  git(merge.path, ['commit', '-m', 'incoming']);
  const incoming = git(merge.path, ['rev-parse', 'HEAD']);
  git(merge.path, ['checkout', 'main']);
  writeFileSync(join(merge.path, 'current.txt'), 'CURRENT\n');
  git(merge.path, ['add', '.']);
  git(merge.path, ['commit', '-m', 'current']);
  await merge.repository.status();
  const beforeMerge = snapshot(merge.path),
    current = git(merge.path, ['rev-parse', 'HEAD']);
  await merge.repository.merge('incoming');
  c.observe(
    'sync.merge',
    merge.repository,
    'merge',
    beforeMerge,
    snapshot(merge.path),
    [current, incoming],
    parents(merge.path),
  );
  const conflict = await create('abort');
  git(conflict.path, ['checkout', '-b', 'incoming']);
  writeFileSync(join(conflict.path, 'fixture.txt'), 'THEIRS\n');
  git(conflict.path, ['commit', '-am', 'theirs']);
  git(conflict.path, ['checkout', 'main']);
  writeFileSync(join(conflict.path, 'fixture.txt'), 'OURS\n');
  git(conflict.path, ['commit', '-am', 'ours']);
  await conflict.repository.status();
  const beforeAbort = snapshot(conflict.path);
  await assert.rejects(conflict.repository.merge('incoming'));
  assert.ok(existsSync(join(conflict.path, '.git/MERGE_HEAD')));
  await conflict.repository.mergeAbort();
  assert.ok(!existsSync(join(conflict.path, '.git/MERGE_HEAD')));
  assert.equal(git(conflict.path, ['ls-files', '-u']), '');
  c.observe(
    'sync.abort',
    conflict.repository,
    'mergeAbort',
    beforeAbort,
    snapshot(conflict.path),
    beforeAbort,
    snapshot(conflict.path),
  );
  const remote = join(c.root, 'sync-remote.git');
  git(c.root, ['init', '--bare', remote]);
  const seed = await create('seed');
  git(seed.path, ['remote', 'add', 'origin', remote]);
  git(seed.path, ['push', '-u', 'origin', 'main']);
  git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(seed.path, ['branch', 'obsolete']);
  git(seed.path, ['push', 'origin', 'obsolete']);
  const clones = async (name: string) => {
    const path = join(c.root, name);
    git(c.root, ['clone', remote, path]);
    identity(path);
    const repository = await c.api.openRepository(vscode.Uri.file(path));
    assert.ok(repository);
    await repository.status();
    return { path, repository };
  };
  const fetch = await clones('fetch');
  const other = join(c.root, 'other-remote.git');
  git(c.root, ['clone', '--bare', remote, other]);
  git(fetch.path, ['remote', 'add', 'other', other]);
  writeFileSync(join(seed.path, 'incoming.txt'), 'REMOTE NEXT\n');
  git(seed.path, ['add', '.']);
  git(seed.path, ['commit', '-m', 'remote next']);
  git(seed.path, ['push', 'origin', 'main']);
  git(seed.path, ['push', other, 'main']);
  const fetchBefore = snapshot(fetch.path),
    diskBefore = readFileSync(join(fetch.path, 'fixture.txt'), 'utf8');
  await vscode.commands.executeCommand('git.fetchAll', fetch.repository.rootUri);
  assert.equal(
    git(fetch.path, ['rev-parse', 'refs/remotes/origin/main']),
    git(seed.path, ['rev-parse', 'HEAD']),
  );
  assert.equal(
    git(fetch.path, ['rev-parse', 'refs/remotes/other/main']),
    git(seed.path, ['rev-parse', 'HEAD']),
  );
  git(seed.path, ['push', 'origin', '--delete', 'obsolete']);
  await vscode.commands.executeCommand('git.fetchPrune', fetch.repository.rootUri);
  assert.throws(() => git(fetch.path, ['rev-parse', '--verify', 'refs/remotes/origin/obsolete']));
  c.observe(
    'sync.fetch',
    fetch.repository,
    'git.fetchAll/git.fetchPrune',
    fetchBefore,
    {
      ...snapshot(fetch.path),
      origin: git(fetch.path, ['rev-parse', 'origin/main']),
      other: git(fetch.path, ['rev-parse', 'other/main']),
      obsolete: false,
    },
    diskBefore,
    readFileSync(join(fetch.path, 'fixture.txt'), 'utf8'),
    'native-command',
  );
  await fetch.repository.status();
  const counts = git(fetch.path, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
    .split(/\s+/)
    .map(Number);
  c.observe(
    'sync.aheadBehind',
    fetch.repository,
    'state.HEAD',
    fetchBefore,
    { head: fetch.repository.state.HEAD, counts },
    { ahead: counts[0], behind: counts[1] },
    { ahead: fetch.repository.state.HEAD?.ahead, behind: fetch.repository.state.HEAD?.behind },
  );
  for (const strategy of ['merge', 'rebase', 'ff-only']) {
    const item = await clones('pull-' + strategy);
    writeFileSync(join(item.path, 'local.txt'), 'LOCAL ' + strategy + '\n');
    git(item.path, ['add', '.']);
    git(item.path, ['commit', '-m', 'local ' + strategy]);
    writeFileSync(join(seed.path, `peer-${strategy}.txt`), 'REMOTE ' + strategy + '\n');
    git(seed.path, ['add', '.']);
    git(seed.path, ['commit', '-m', 'peer ' + strategy]);
    git(seed.path, ['push', 'origin', 'main']);
    git(item.path, ['config', 'pull.rebase', 'false']);
    git(item.path, ['config', 'pull.ff', strategy === 'ff-only' ? 'only' : 'true']);
    await item.repository.status();
    const before = snapshot(item.path),
      old = git(item.path, ['rev-parse', 'HEAD']);
    if (strategy === 'ff-only') {
      await assert.rejects(item.repository.pull(), /diverg|fast-forward|ff-only/i);
      c.observe(
        'sync.divergence',
        item.repository,
        'git.pull',
        before,
        snapshot(item.path),
        before,
        snapshot(item.path),
      );
    } else {
      const command = strategy === 'merge' ? 'git.pull' : 'git.pullRebase';
      await vscode.commands.executeCommand(command, item.repository.rootUri);
      const count = parents(item.path).length;
      assert.equal(readFileSync(join(item.path, 'local.txt'), 'utf8'), 'LOCAL ' + strategy + '\n');
      assert.equal(
        readFileSync(join(item.path, `peer-${strategy}.txt`), 'utf8'),
        'REMOTE ' + strategy + '\n',
      );
      c.observe(
        strategy === 'merge' ? 'sync.pull' : 'sync.rebase',
        item.repository,
        command,
        before,
        { ...snapshot(item.path), old },
        { parents: strategy === 'merge' ? 2 : 1, changed: true },
        { parents: count, changed: git(item.path, ['rev-parse', 'HEAD']) !== old },
        'native-command',
      );
    }
  }
  await vscode.commands.executeCommand('workbench.view.scm');
  c.artifact('history-gaps', {
    gaps: [
      'No physical history row navigation was driven; commit diff navigation remains unverified.',
      'No visible fetch baseline timestamp capability asserted.',
      'No selected remote/ref QuickPick was driven.',
    ],
  });
}
