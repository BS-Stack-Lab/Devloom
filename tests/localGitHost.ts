import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { API } from '../vendor/code-oss/extensions/git/src/api/git';
import { git, baseline, changed, selected, snapshot } from './localGitFixtures';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function run(): Promise<void> {
  const evidence = process.env.DEVLOOM_EVIDENCE_DIR!;
  const root = process.env.DEVLOOM_GIT_FIXTURE!;
  const repositoryPath = join(root, 'repository');
  const file = join(repositoryPath, 'fixture.txt');
  const result: Record<string, unknown> = {
    status: 'fail',
    pid: process.pid,
    appRoot: vscode.env.appRoot,
    profile: process.env.DEVLOOM_GIT_PROFILE,
  };
  try {
    if (process.env.DEVLOOM_GIT_PROFILE === 'missing') {
      const diagnostic = await vscode.commands.executeCommand<{
        action?: string;
        executable?: string;
      }>('devloom.diagnoseLocalGit');
      assert.equal(diagnostic?.executable, undefined);
      assert.match(diagnostic?.action || '', /Git is unavailable/);
      result.diagnostic = diagnostic;
      result.status = 'pass';
      return;
    }
    if (process.env.DEVLOOM_GIT_PROFILE === 'untrusted') {
      const diagnostic = await vscode.commands.executeCommand<{ trusted: boolean }>(
        'devloom.diagnoseLocalGit',
      );
      assert.equal(diagnostic?.trusted, false);
      assert.equal(existsSync(join(root, 'execution-marker')), false);
      result.diagnostic = diagnostic;
      result.status = 'pass';
      return;
    }
    const extension = vscode.extensions.getExtension<{ getAPI(version: number): API }>(
      'vscode.git',
    );
    assert.ok(extension);
    const api = (await extension.activate()).getAPI(1);
    if (process.env.DEVLOOM_GIT_PROFILE === 'unsupported') {
      result.diagnostic = await vscode.commands.executeCommand(
        'devloom.diagnoseLocalGit',
        vscode.Uri.file(repositoryPath),
      );
      assert.match(JSON.stringify(result.diagnostic), /2\.0\.0/);
      assert.match(JSON.stringify(result.diagnostic), /supported\":false/);
      const before = snapshot(repositoryPath);
      await assert.rejects(api.init(vscode.Uri.file(repositoryPath)), /Git 2.28 or later/);
      assert.deepEqual(snapshot(repositoryPath), before);
      result.status = 'pass';
      return;
    }
    const repository = await api.openRepository(vscode.Uri.file(repositoryPath));
    assert.ok(repository);
    await repository.status();
    result.diagnostic = await vscode.commands.executeCommand(
      'devloom.diagnoseLocalGit',
      repository.rootUri,
    );
    assert.match(JSON.stringify(result.diagnostic), /2\.53\.0/);
    const initPath = join(root, 'native-init');
    mkdirSync(initPath);
    await api.init(vscode.Uri.file(initPath));
    assert.ok(existsSync(join(initPath, '.git/HEAD')));
    const cloneParent = join(root, 'clone-parent');
    mkdirSync(cloneParent);
    const clone = await api.clone(vscode.Uri.file(join(root, 'remote.git')), {
      parentPath: vscode.Uri.file(cloneParent),
      postCloneAction: 'none',
    });
    assert.ok(clone);
    assert.equal(
      git(clone.fsPath, ['rev-parse', 'HEAD']),
      git(repositoryPath, ['rev-parse', 'HEAD']),
    );
    result.initClone = true;
    writeFileSync(file, changed);
    await repository.status();
    const modified = vscode.Uri.file(file);
    const original = modified.with({
      scheme: 'git',
      query: JSON.stringify({ path: file, ref: '~' }),
    });
    await vscode.commands.executeCommand(
      'vscode.diff',
      original,
      modified,
      'Selected Hunk Fixture',
    );
    await delay(1500);
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor && editor.document.uri.scheme === 'file', 'actual diff editor must be active');
    editor.selection = new vscode.Selection(1, 0, 1, 15);
    await vscode.commands.executeCommand('git.stageSelectedRanges');
    assert.equal(git(repositoryPath, ['show', ':fixture.txt']) + '\n', selected);
    assert.equal(readFileSync(file, 'utf8'), changed);
    assert.match(await repository.diff(), /remaining change/);
    assert.match(await repository.diff(true), /selected change/);
    result.selectedStage = { index: selected, disk: changed, selection: editor.selection };
    const precomputed = {
      mapping: {},
      originalWithModifiedChanges: 'forbidden stale content\n',
      originalBaseline: 'stale baseline',
      modifiedVersion: editor.document.version,
      originalUri: original,
      modifiedUri: modified,
    };
    await vscode.commands.executeCommand('git.diff.stageHunk', precomputed);
    assert.equal(git(repositoryPath, ['show', ':fixture.txt']) + '\n', selected);
    result.staleGutterRefused = true;

    const staged = modified.with({ scheme: 'git', query: JSON.stringify({ path: file, ref: '' }) });
    const head = modified.with({
      scheme: 'git',
      query: JSON.stringify({ path: file, ref: 'HEAD' }),
    });
    await vscode.commands.executeCommand('vscode.diff', head, staged, 'Unstage Selected Fixture');
    await delay(1500);
    const stagedEditor = vscode.window.activeTextEditor;
    assert.ok(stagedEditor);
    stagedEditor.selection = new vscode.Selection(1, 0, 1, 15);
    await vscode.commands.executeCommand('git.unstageSelectedRanges');
    assert.equal(git(repositoryPath, ['show', ':fixture.txt']) + '\n', baseline);
    assert.equal(readFileSync(file, 'utf8'), changed);
    await vscode.commands.executeCommand(
      'vscode.diff',
      original,
      modified,
      'Restage Selected Fixture',
    );
    await delay(1500);
    const restageEditor = vscode.window.activeTextEditor;
    assert.ok(restageEditor);
    restageEditor.selection = new vscode.Selection(1, 0, 1, 15);
    await vscode.commands.executeCommand('git.stageSelectedRanges');
    repository.inputBox.value = 'selected content\n\nNative multiline message';
    await repository.commit(repository.inputBox.value);
    assert.equal(git(repositoryPath, ['show', 'HEAD:fixture.txt']) + '\n', selected);
    assert.equal(
      git(repositoryPath, ['log', '-1', '--format=%B']),
      'selected content\n\nNative multiline message',
    );
    writeFileSync(file, selected);
    await repository.status();
    await repository.createBranch('기능+native', true);
    await repository.push('origin', '기능+native', true);
    assert.equal(
      git(join(root, 'remote.git'), ['rev-parse', 'refs/heads/기능+native']),
      git(repositoryPath, ['rev-parse', 'HEAD']),
    );
    const peer = join(root, 'peer');
    git(peer, ['fetch']);
    git(peer, ['checkout', '-b', '기능+native', '--track', 'origin/기능+native']);
    writeFileSync(join(peer, 'peer.txt'), 'remote content\n');
    git(peer, ['add', '.']);
    git(peer, ['commit', '-m', 'peer commit']);
    git(peer, ['push']);
    await repository.fetch();
    assert.equal(existsSync(join(repositoryPath, 'peer.txt')), false);
    await repository.pull();
    assert.equal(readFileSync(join(repositoryPath, 'peer.txt'), 'utf8'), 'remote content\n');
    result.sync = snapshot(repositoryPath);
    await repository.createBranch('conflicting', true);
    writeFileSync(file, baseline.replace('line 2', 'conflicting side'));
    await repository.add([file]);
    await repository.commit('conflicting side');
    await repository.checkout('기능+native');
    writeFileSync(file, selected.replace('selected change', 'main side'));
    await repository.add([file]);
    await repository.commit('main side');
    await assert.rejects(repository.merge('conflicting'));
    assert.ok(existsSync(join(repositoryPath, '.git/MERGE_HEAD')));
    assert.match(git(repositoryPath, ['ls-files', '-u']), /fixture.txt/);
    result.conflict = snapshot(repositoryPath);
    writeFileSync(file, 'resolved\n');
    await repository.add([file]);
    await repository.commit('resolved merge');
    assert.equal(git(repositoryPath, ['log', '-1', '--format=%P']).split(' ').length, 2);
    const hooks = join(root, 'fixture-hooks');
    mkdirSync(hooks);
    git(repositoryPath, ['config', 'core.hooksPath', hooks]);
    const hook = join(hooks, 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o700);
    writeFileSync(file, 'hook staged bytes\n');
    await repository.add([file]);
    const before = snapshot(repositoryPath);
    await assert.rejects(repository.commit('hook failure'));
    assert.deepEqual(snapshot(repositoryPath), before);
    unlinkSync(hook);
    await repository.commit('explicit retry');
    const lock = join(repositoryPath, '.git/index.lock');
    writeFileSync(lock, 'external writer');
    writeFileSync(file, 'external lock preserves work\n');
    const pendingStage = repository.add([file]);
    await delay(150);
    assert.equal(readFileSync(lock, 'utf8'), 'external writer');
    unlinkSync(lock);
    writeFileSync(join(repositoryPath, 'peer.txt'), 'terminal staged bytes\n');
    git(repositoryPath, ['add', 'peer.txt']);
    await assert.rejects(pendingStage, /state changed|Refresh Source Control/);
    assert.equal(git(repositoryPath, ['show', ':peer.txt']), 'terminal staged bytes');
    assert.equal(git(repositoryPath, ['show', ':fixture.txt']), 'hook staged bytes');
    git(repositoryPath, ['fsck', '--no-dangling']);
    result.final = snapshot(repositoryPath);
    result.finalDiagnostic = await vscode.commands.executeCommand(
      'devloom.diagnoseLocalGit',
      repository.rootUri,
    );
    result.status = 'pass';
  } catch (error) {
    result.error = error instanceof Error ? error.stack : String(error);
    throw error;
  } finally {
    writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  }
}
