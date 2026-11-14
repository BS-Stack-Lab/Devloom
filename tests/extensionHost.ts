import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeClient } from '../extensions/devloom-bootstrap/src/bridgeClient';
type GitRepository = {
  rootUri: vscode.Uri;
  state: { workingTreeChanges: { uri: vscode.Uri }[] };
  status(): Promise<void>;
};
type GitApi = {
  repositories: GitRepository[];
  openRepository(uri: vscode.Uri): Promise<GitRepository | null>;
};
export async function run(): Promise<void> {
  const evidence = process.env.DEVLOOM_EVIDENCE_DIR;
  assert.ok(evidence);
  const result: Record<string, unknown> = { status: 'fail' };
  let client: BridgeClient | undefined;
  try {
    const extension = vscode.extensions.getExtension<{ client: BridgeClient }>(
      'devloom.devloom-bootstrap',
    );
    assert.ok(extension);
    result.wasActiveBeforeCommand = extension.isActive;
    assert.equal(extension.isActive, false);
    const verified = await vscode.commands.executeCommand<{
      hello: { protocolMajor: number };
      echo: { text: string };
      pid: number;
    }>('devloom.verifyLocalBridge');
    assert.ok(verified);
    assert.equal(verified.hello.protocolMajor, 1);
    assert.equal(verified.echo.text, '한글 e\u0301 👨‍👩‍👧‍👦\nDevloom');
    assert.equal(extension.isActive, true);
    client = extension.exports.client;
    result.bridge = verified;
    const delayed = client.request('delay', { text: '', delayMs: 10000 });
    const rejected = assert.rejects(delayed, /TransportClosed/);
    process.kill(client.pid!, 'SIGKILL');
    await rejected;
    await vscode.commands.executeCommand('devloom.restartLocalBridge');
    assert.notEqual(client.pid, verified.pid);
    assert.deepEqual(await client.request('echo', { text: 'host recovered' }), {
      text: 'host recovered',
    });
    result.restarted = client.diagnostics;
    assert.equal(vscode.env.appName, 'Devloom IDE Dev');
    result.appName = vscode.env.appName;
    const gitExtension = vscode.extensions.getExtension<{ getAPI(version: number): GitApi }>(
      'vscode.git',
    );
    assert.ok(gitExtension);
    const api = (await gitExtension.activate()).getAPI(1);
    const workspace = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspace);
    const repository = await api.openRepository(workspace.uri);
    assert.ok(repository);
    await repository.status();
    const changed = repository.state.workingTreeChanges.map((change) => change.uri.fsPath);
    assert.ok(changed.includes(join(workspace.uri.fsPath, 'fixture.ts')));
    result.git = {
      id: gitExtension.id,
      active: gitExtension.isActive,
      changed,
      root: repository.rootUri.fsPath,
    };
    result.extensions = vscode.extensions.all.map((item) => ({
      id: item.id,
      version: item.packageJSON.version,
      isActive: item.isActive,
      extensionPath: item.extensionPath,
    }));
    await vscode.commands.executeCommand('devloom.stopLocalBridge');
    assert.equal(client.state, 'stopped');
    result.stopped = client.diagnostics;
    result.status = 'pass';
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await client?.stop();
    writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  }
}
