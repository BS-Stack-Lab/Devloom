import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Status } from '../vendor/code-oss/extensions/git/src/api/git';
import { git, identity, snapshot } from './localGitFixtures';
import type { Context } from './localGitP1Host';
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until(predicate: () => boolean) {
  const end = Date.now() + 10000;
  while (!predicate()) {
    assert.ok(Date.now() < end, 'NATIVE_WATCHER_TIMEOUT');
    await pause(50);
  }
}
export async function changes(c: Context): Promise<void> {
  const path = join(c.root, 'changes');
  mkdirSync(path);
  git(path, ['init', '-b', 'main']);
  identity(path);
  const files = [
    'fixture.txt',
    'modified.txt',
    'deleted.txt',
    'renamed.txt',
    'conflict.txt',
    'folder/one.txt',
    'folder/nested/two.txt',
    'sibling.txt',
  ];
  mkdirSync(join(path, 'folder/nested'), { recursive: true });
  for (const file of files) writeFileSync(join(path, file), `BASE ${file}\n`);
  git(path, ['add', '.']);
  git(path, ['commit', '-m', 'changes base']);
  git(path, ['checkout', '-b', 'incoming']);
  writeFileSync(join(path, 'conflict.txt'), 'INCOMING\n');
  git(path, ['commit', '-am', 'incoming conflict']);
  git(path, ['checkout', 'main']);
  writeFileSync(join(path, 'conflict.txt'), 'CURRENT\n');
  git(path, ['commit', '-am', 'current conflict']);
  try {
    git(path, ['merge', 'incoming']);
  } catch {}
  writeFileSync(join(path, 'modified.txt'), 'MODIFIED\n');
  unlinkSync(join(path, 'deleted.txt'));
  git(path, ['mv', 'renamed.txt', 'renamed-new.txt']);
  writeFileSync(join(path, 'added.txt'), 'ADDED\n');
  git(path, ['add', 'added.txt']);
  writeFileSync(join(path, 'untracked.txt'), 'UNTRACKED\n');
  const repository = await c.api.openRepository(vscode.Uri.file(path));
  assert.ok(repository);
  await repository.status();
  const actual = Object.fromEntries(
    [
      ...repository.state.indexChanges,
      ...repository.state.workingTreeChanges,
      ...repository.state.mergeChanges,
    ].map((change) => [change.uri.fsPath.slice(path.length + 1), change.status]),
  );
  const expected = {
    'added.txt': Status.INDEX_ADDED,
    'modified.txt': Status.MODIFIED,
    'deleted.txt': Status.DELETED,
    'renamed-new.txt': Status.INDEX_RENAMED,
    'untracked.txt': Status.UNTRACKED,
    'conflict.txt': Status.BOTH_MODIFIED,
  };
  for (const [file, status] of Object.entries(expected)) assert.equal(actual[file], status, file);
  const statusOracle = git(path, ['status', '--porcelain=v1']);
  await vscode.commands.executeCommand('workbench.view.scm');
  const rendered = await c.present('status', {
    texts: Object.keys(expected),
    kind: 'status',
    expected,
  });
  c.observe(
    'changes.status',
    repository,
    'state',
    { oracle: statusOracle },
    { actual, rendered },
    expected,
    Object.fromEntries(Object.keys(expected).map((key) => [key, actual[key]])),
  );
  assert.ok(existsSync(join(path, '.git/MERGE_HEAD')));
  const conflictDocument = await vscode.workspace.openTextDocument(
    vscode.Uri.file(join(path, 'conflict.txt')),
  );
  const resolution = new vscode.WorkspaceEdit();
  resolution.replace(
    conflictDocument.uri,
    new vscode.Range(
      conflictDocument.positionAt(0),
      conflictDocument.positionAt(conflictDocument.getText().length),
    ),
    'RESOLVED CURRENT AND INCOMING\n',
  );
  assert.ok(await vscode.workspace.applyEdit(resolution));
  assert.ok(await conflictDocument.save());
  await repository.add([join(path, 'conflict.txt')]);
  assert.ok(existsSync(join(path, '.git/MERGE_HEAD')));
  assert.equal(git(path, ['ls-files', '-u']), '');
  c.artifact('merge-file-complete', {
    mergeHead: git(path, ['rev-parse', 'MERGE_HEAD']),
    head: git(path, ['rev-parse', 'HEAD']),
    index: git(path, ['show', ':conflict.txt']),
    disk: readFileSync(join(path, 'conflict.txt'), 'utf8'),
    repositoryMergeStillPending: true,
  });
  await vscode.commands.executeCommand('git.stageAll', repository.rootUri);
  await repository.commit('native status matrix merge baseline');
  assert.ok(!existsSync(join(path, '.git/MERGE_HEAD')));
  assert.equal(git(path, ['status', '--porcelain=v1']), '');
  writeFileSync(join(path, 'fixture.txt'), 'INDEX SENTINEL\n whitespace  \n');
  await repository.add([join(path, 'fixture.txt')]);
  writeFileSync(join(path, 'fixture.txt'), 'WORKING SENTINEL\n whitespace    \n');
  await repository.status();
  const uri = vscode.Uri.file(join(path, 'fixture.txt'));
  const head = c.api.toGitUri(uri, 'HEAD'),
    index = c.api.toGitUri(uri, ''),
    working = c.api.toGitUri(uri, '~');
  const baseline = {
    ...snapshot(path),
    buffer: (await vscode.workspace.openTextDocument(uri)).getText(),
    version: (await vscode.workspace.openTextDocument(uri)).version,
  };
  await vscode.commands.executeCommand('vscode.diff', head, index, `STAGED ${c.nonce}`);
  const staged = await c.present('staged', {
    texts: ['INDEX SENTINEL'],
    uris: [head.toString(), index.toString()],
    panes: [
      { role: 'original', text: 'BASE fixture.txt' },
      { role: 'modified', text: 'INDEX SENTINEL' },
    ],
  });
  const cached = await repository.diff(true);
  assert.match(cached, /INDEX SENTINEL/);
  assert.doesNotMatch(cached, /WORKING SENTINEL/);
  await vscode.commands.executeCommand('vscode.diff', working, uri, `WORKING ${c.nonce}`);
  const unstaged = await c.present('working', {
    texts: ['WORKING SENTINEL'],
    uris: [working.toString(), uri.toString()],
    panes: [
      { role: 'original', text: 'INDEX SENTINEL' },
      { role: 'modified', text: 'WORKING SENTINEL' },
    ],
  });
  const diff = await repository.diff(false);
  assert.match(diff, /WORKING SENTINEL/);
  assert.match(diff, /INDEX SENTINEL/);
  c.observe(
    'changes.paired',
    repository,
    'vscode.diff',
    baseline,
    { staged, unstaged, cached, diff },
    { cachedHasIndex: true, workingHasBoth: true },
    {
      cachedHasIndex: cached.includes('INDEX SENTINEL') && !cached.includes('WORKING SENTINEL'),
      workingHasBoth: diff.includes('WORKING SENTINEL') && diff.includes('INDEX SENTINEL'),
    },
  );
  const configuration = vscode.workspace.getConfiguration('diffEditor');
  await configuration.update(
    'useInlineViewWhenSpaceIsLimited',
    false,
    vscode.ConfigurationTarget.Global,
  );
  const layouts = [];
  for (const side of [true, false]) {
    await configuration.update('renderSideBySide', side, vscode.ConfigurationTarget.Global);
    layouts.push(
      await c.present(side ? 'side' : 'inline', {
        texts: ['WORKING SENTINEL'],
        layout: side ? 'side-by-side' : 'inline',
      }),
    );
  }
  c.observe(
    'changes.layout',
    repository,
    'diffEditor.renderSideBySide',
    baseline,
    { layouts },
    baseline,
    {
      ...snapshot(path),
      buffer: (await vscode.workspace.openTextDocument(uri)).getText(),
      version: (await vscode.workspace.openTextDocument(uri)).version,
    },
  );
  const whitespace: { dom: { editors: { decorations: number }[] } }[] = [];
  for (const ignore of [true, false]) {
    await configuration.update('ignoreTrimWhitespace', ignore, vscode.ConfigurationTarget.Global);
    whitespace.push(
      (await c.present(ignore ? 'ignore-whitespace' : 'show-whitespace', {
        texts: ['WORKING SENTINEL'],
        ignoreTrimWhitespace: ignore,
      })) as { dom: { editors: { decorations: number }[] } },
    );
  }
  assert.ok(
    whitespace[1].dom.editors.reduce((n, e) => n + e.decorations, 0) >
      whitespace[0].dom.editors.reduce((n, e) => n + e.decorations, 0),
    'Whitespace hiding must change rendered diff decorations',
  );
  c.observe(
    'changes.whitespace',
    repository,
    'diffEditor.ignoreTrimWhitespace',
    baseline,
    { whitespace },
    baseline,
    {
      ...snapshot(path),
      buffer: (await vscode.workspace.openTextDocument(uri)).getText(),
      version: (await vscode.workspace.openTextDocument(uri)).version,
    },
  );
  await repository.revert([join(path, 'fixture.txt')]);
  const beforeFolder = git(path, ['ls-files', '--stage']);
  for (const file of ['folder/one.txt', 'folder/nested/two.txt', 'sibling.txt'])
    writeFileSync(join(path, file), `CHANGED ${file}\n`);
  const disk = Object.fromEntries(
    ['folder/one.txt', 'folder/nested/two.txt', 'sibling.txt'].map((file) => [
      file,
      readFileSync(join(path, file), 'utf8'),
    ]),
  );
  await repository.add([join(path, 'folder')]);
  const stagedPaths = git(path, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  assert.deepEqual(stagedPaths, ['folder/nested/two.txt', 'folder/one.txt']);
  await repository.revert([join(path, 'folder')]);
  assert.equal(git(path, ['ls-files', '--stage']), beforeFolder);
  c.observe(
    'changes.folder',
    repository,
    'add/revert',
    { index: beforeFolder, disk },
    { index: git(path, ['ls-files', '--stage']), stagedPaths, disk },
    disk,
    Object.fromEntries(
      Object.keys(disk).map((file) => [file, readFileSync(join(path, file), 'utf8')]),
    ),
  );
  const allDisk = { ...disk, 'fixture.txt': readFileSync(join(path, 'fixture.txt'), 'utf8') };
  await vscode.commands.executeCommand('git.stageAll', repository.rootUri);
  const all = git(path, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  assert.deepEqual(all, ['fixture.txt', 'folder/nested/two.txt', 'folder/one.txt', 'sibling.txt']);
  await vscode.commands.executeCommand('git.unstageAll', repository.rootUri);
  assert.equal(git(path, ['diff', '--cached']), '');
  c.observe(
    'changes.all',
    repository,
    'git.stageAll/git.unstageAll',
    { index: beforeFolder, disk: allDisk },
    { all, index: git(path, ['ls-files', '--stage']) },
    allDisk,
    Object.fromEntries(
      Object.keys(allDisk).map((file) => [file, readFileSync(join(path, file), 'utf8')]),
    ),
  );
  await vscode.commands.executeCommand('git.stageAll', repository.rootUri);
  await repository.commit('native changes cleanup');
  let events = 0;
  const listener = repository.state.onDidChange(() => events++);
  try {
    const before = snapshot(path);
    writeFileSync(join(path, 'fixture.txt'), 'EXTERNAL COMMIT\n');
    git(path, ['add', 'fixture.txt']);
    git(path, ['commit', '-m', 'external terminal commit']);
    const external = git(path, ['rev-parse', 'HEAD']);
    await until(
      () =>
        events > 0 &&
        repository.state.HEAD?.commit === external &&
        repository.state.indexChanges.length === 0,
    );
    const commitRendered = await c.present('external-commit', {
      texts: [],
      kind: 'watcher',
      head: external,
    });
    git(path, ['branch', 'external-checkout', 'HEAD~1']);
    git(path, ['checkout', 'external-checkout']);
    const checkoutHead = git(path, ['rev-parse', 'HEAD']);
    await until(
      () =>
        repository.state.HEAD?.name === 'external-checkout' &&
        repository.state.HEAD?.commit === checkoutHead &&
        repository.state.indexChanges.length === 0,
    );
    const checkoutDiff = await repository.diff(false);
    assert.equal(checkoutDiff, git(path, ['diff']));
    const checkoutRendered = await c.present('external-checkout', {
      texts: ['external-checkout'],
      kind: 'watcher',
    });
    c.observe(
      'changes.external',
      repository,
      'watcher',
      before,
      { events, commitRendered, checkoutRendered, checkoutDiff, oracle: snapshot(path) },
      { head: checkoutHead, name: 'external-checkout', events: true },
      {
        head: repository.state.HEAD?.commit,
        name: repository.state.HEAD?.name,
        events: events > 0,
      },
      'native-watcher',
    );
  } finally {
    listener.dispose();
  }
}
