import * as vscode from 'vscode';
import { existsSync, readFileSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

type Request = {
  nonce: string;
  stage: string;
  activation: string;
  action: 'read' | 'write' | 'quit';
  value?: string;
};
type Fixture = { nonce: string; channel: string; workspace: string };

export function activate(context: vscode.ExtensionContext): void {
  const fixture = JSON.parse(
    readFileSync(join(context.extensionPath, 'fixture.json'), 'utf8'),
  ) as Fixture;
  if (!/^[a-f0-9]{32}$/.test(fixture.nonce)) throw new Error('Invalid profile fixture nonce');
  const activation = randomUUID();
  const started = Date.now();
  const mainPid = Number(process.env.VSCODE_PID);
  if (!Number.isSafeInteger(mainPid) || mainPid < 2) throw new Error('Missing native Main PID');
  const metadata = {
    nonce: fixture.nonce,
    activation,
    mainPid,
    extensionHostPid: process.pid,
    parentPid: process.ppid,
    appName: vscode.env.appName,
    started,
  };
  const publish = (name: string, value: object): void => {
    writeFileSync(join(fixture.channel, name), `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  };
  publish(`activation-${activation}.json`, metadata);
  const processed = new Set<string>();
  let running = false;
  const observe = async (request: Request): Promise<void> => {
    if (request.action === 'write') {
      if (typeof request.value !== 'string' || request.value.length > 100)
        throw new Error('Invalid fixture value');
      await vscode.workspace
        .getConfiguration('devloomProfileFixture')
        .update('value', request.value, vscode.ConfigurationTarget.Global);
      await context.globalState.update('value', request.value);
      await context.workspaceState.update('value', request.value);
    }
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspace || realpathSync(workspace) !== realpathSync(fixture.workspace))
      throw new Error('Unexpected fixture workspace');
    publish(`result-${request.stage}.json`, {
      ...metadata,
      stage: request.stage,
      action: request.action,
      status: 'pass',
      observed: Date.now(),
      workspace: realpathSync(workspace),
      storageUri: context.storageUri?.fsPath,
      globalStorageUri: context.globalStorageUri.fsPath,
      setting: vscode.workspace.getConfiguration('devloomProfileFixture').get('value') ?? null,
      globalState: context.globalState.get('value') ?? null,
      workspaceState: context.workspaceState.get('value') ?? null,
    });
    if (request.action === 'quit') {
      clearInterval(timer);
      setTimeout(() => {
        void vscode.commands.executeCommand('workbench.action.quit');
      }, 250);
    }
  };
  const poll = async (): Promise<void> => {
    if (Date.now() - started > 240000) {
      clearInterval(timer);
      return;
    }
    const path = join(fixture.channel, 'request.json');
    if (running || !existsSync(path)) return;
    if (statSync(path).size > 4096) throw new Error('Oversized fixture request');
    const request = JSON.parse(readFileSync(path, 'utf8')) as Request;
    if (
      request.nonce !== fixture.nonce ||
      request.activation !== activation ||
      !/^[a-z0-9-]{1,64}$/.test(request.stage) ||
      !['read', 'write', 'quit'].includes(request.action) ||
      processed.has(request.stage)
    )
      return;
    processed.add(request.stage);
    running = true;
    try {
      await observe(request);
    } catch (error) {
      publish(`result-${request.stage}.json`, {
        ...metadata,
        stage: request.stage,
        status: 'fail',
        error: error instanceof Error ? error.message : 'Fixture failure',
      });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void poll().catch(() => clearInterval(timer));
  }, 75);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}
