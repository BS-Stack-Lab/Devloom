import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { API } from '../vendor/code-oss/extensions/git/src/api/git';
import { git, snapshot } from './localGitFixtures';
import { awaitAutofetch, diagnosticEvents, type GitEvent } from './localGitAutofetch';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(path: string): Promise<void> {
  const deadline = Date.now() + 40000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`Fixture rendezvous timed out: ${path}`);
    await delay(30);
  }
}
export async function run(): Promise<void> {
  const root = process.env.DEVLOOM_GIT_FIXTURE!;
  const evidence = process.env.DEVLOOM_EVIDENCE_DIR!;
  const role = process.env.DEVLOOM_GIT_PROFILE!;
  const repositoryPath = process.env.DEVLOOM_GIT_REPOSITORY || join(root, 'repository');
  const file = join(repositoryPath, 'fixture.txt');
  const result: Record<string, unknown> = {
    status: 'fail',
    role,
    pid: process.pid,
    started: Date.now(),
    repositoryPath,
  };
  const focusEvents: { at: number; focused: boolean }[] = [
    { at: Date.now(), focused: vscode.window.state.focused },
  ];
  const focusListener = vscode.window.onDidChangeWindowState((state) =>
    focusEvents.push({ at: Date.now(), focused: state.focused }),
  );
  let beforeFetch: GitEvent[] = [];
  let enabledAt = 0;
  let upstreamBefore = '';
  try {
    const extension = vscode.extensions.getExtension<{ getAPI(version: number): API }>(
      'vscode.git',
    );
    assert.ok(extension);
    const api = (await extension.activate()).getAPI(1);
    const repository = await api.openRepository(vscode.Uri.file(repositoryPath));
    assert.ok(repository);
    await repository.status();
    result.diagnostic = await vscode.commands.executeCommand(
      'devloom.diagnoseLocalGit',
      repository.rootUri,
    );
    if (role === 'a') {
      writeFileSync(file, 'first host staged bytes\n');
      await repository.add([file]);
    } else {
      await wait(join(root, 'ready-a'));
      await repository.status();
    }
    writeFileSync(join(root, `ready-${role}`), String(process.pid));
    await wait(join(root, `go-${role}`));
    if (role === 'a') {
      result.commitStarted = Date.now();
      await repository.commit('first host coordinated commit');
      result.commitCompleted = Date.now();
      assert.equal(git(repositoryPath, ['show', 'HEAD:fixture.txt']), 'first host staged bytes');
      await wait(join(root, 'finished-b'));
    } else {
      writeFileSync(file, 'second host working bytes\n');
      result.requested = Date.now();
      const scenario = process.env.DEVLOOM_GIT_SCENARIO;
      if (scenario === 'alias') {
        beforeFetch = diagnosticEvents(
          await vscode.commands.executeCommand('devloom.diagnoseLocalGit', repository.rootUri),
        );
        upstreamBefore = git(repositoryPath, ['rev-parse', 'refs/remotes/origin/main']);
        enabledAt = Date.now();
        result.autofetchEnabled = enabledAt;
        result.autofetchBefore = beforeFetch;
        await vscode.workspace
          .getConfiguration('git')
          .update('autofetch', 'all', vscode.ConfigurationTarget.Global);
        await vscode.commands.executeCommand('workbench.action.focusWindow');
        const stage = repository.add([file]);
        writeFileSync(join(root, 'requested-b'), String(result.requested));
        await stage;
        result.completed = Date.now();
        assert.equal(git(repositoryPath, ['show', ':fixture.txt']), 'second host working bytes');
      } else {
        await assert.rejects(repository.add([file]), (error: Error) => {
          result.initialRejection = error.message;
          return /state changed|Refresh Source Control/.test(error.message);
        });
        result.staleRejected = Date.now();
        writeFileSync(join(root, 'requested-b'), String(result.requested));
        if (scenario?.endsWith('crash')) {
          await wait(join(root, 'crashed'));
          await assert.rejects(
            repository.add([file]),
            /quarantined|coordinator|ECONNREFUSED|ENOENT/,
          );
          result.crashRejected = Date.now();
        }
        assert.equal(git(repositoryPath, ['show', ':fixture.txt']), 'first host staged bytes');
      }
      assert.equal(readFileSync(file, 'utf8'), 'second host working bytes\n');
    }
    result.final = snapshot(repositoryPath);
    result.finalDiagnostic = await vscode.commands.executeCommand(
      'devloom.diagnoseLocalGit',
      repository.rootUri,
    );
    if (process.env.DEVLOOM_GIT_SCENARIO === 'alias' && role === 'b') {
      result.autofetch = await awaitAutofetch({
        before: beforeFetch,
        enabledAt,
        releasedAt: Number(readFileSync(join(root, 'release'), 'utf8')),
        focused: () => vscode.window.state.focused,
        inspect: () =>
          vscode.commands.executeCommand('devloom.diagnoseLocalGit', repository.rootUri),
      });
      result.focusEvents = focusEvents;
      assert.equal(git(repositoryPath, ['rev-parse', 'refs/remotes/origin/main']), upstreamBefore);
      assert.equal(readFileSync(file, 'utf8'), 'second host working bytes\n');
      assert.match(
        JSON.stringify((result.autofetch as { diagnostic: unknown }).diagnostic),
        /ready/,
      );
    }
    if (role === 'b') writeFileSync(join(root, 'finished-b'), 'done');
    result.status = 'pass';
  } catch (error) {
    result.error = error instanceof Error ? error.stack : String(error);
    if (error && typeof error === 'object' && 'diagnostics' in error)
      result.autofetchTimeout = error.diagnostics;
    throw error;
  } finally {
    result.focusEvents = focusEvents;
    focusListener.dispose();
    if (enabledAt)
      await vscode.workspace
        .getConfiguration('git')
        .update('autofetch', false, vscode.ConfigurationTarget.Global);
    writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  }
}
