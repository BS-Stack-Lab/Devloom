import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Scenarios, bounded } from './commitStateScenarios';

type Fixture = {
  nonce: string;
  session: string;
  channel: string;
  workspace: string;
  profile: string;
  sourceDigest: string;
};
type Request = {
  nonce: string;
  session: string;
  activation: string;
  sequence: number;
  stage: string;
  action: string;
  name: string;
};
export function activate(context: vscode.ExtensionContext): void {
  const fixture = JSON.parse(
    readFileSync(join(context.extensionPath, 'fixture.json'), 'utf8'),
  ) as Fixture;
  assert.match(fixture.nonce, /^[a-f0-9]{32}$/);
  const metadata = {
    nonce: fixture.nonce,
    sourceDigest: fixture.sourceDigest,
    session: fixture.session,
    activation: randomUUID(),
    mainPid: Number(process.env.VSCODE_PID),
    extensionHostPid: process.pid,
    started: Date.now(),
    appName: vscode.env.appName,
    workspace: realpathSync(fixture.workspace),
    profile: fixture.profile,
    storageUri: context.storageUri?.fsPath,
    globalStorageUri: context.globalStorageUri.fsPath,
  };
  assert.ok(metadata.mainPid > 1);
  assert.equal(realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), metadata.workspace);
  const publish = (name: string, value: object) =>
    writeFileSync(
      join(fixture.channel, name),
      `${JSON.stringify({ ...metadata, ...value }, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
  const scenarios = new Scenarios(fixture.workspace, fixture.nonce);
  let sequence = 0;
  let running = false;
  let ready = false;
  void scenarios.initialize().then(
    () => {
      ready = true;
      publish(`activation-${metadata.activation}.json`, { status: 'pass', observed: Date.now() });
    },
    (error: unknown) =>
      publish(`activation-${metadata.activation}.json`, {
        status: 'fail',
        error: String(error),
        observed: Date.now(),
      }),
  );
  const poll = async () => {
    if (!ready || running || Date.now() - metadata.started > 360000) return;
    const path = join(fixture.channel, 'request.json');
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096);
    const request = JSON.parse(readFileSync(path, 'utf8')) as Request;
    if (
      request.nonce !== fixture.nonce ||
      request.session !== fixture.session ||
      request.activation !== metadata.activation ||
      request.sequence <= sequence ||
      !Number.isSafeInteger(request.sequence) ||
      !/^[a-z0-9-]{1,64}$/.test(request.stage)
    )
      return;
    sequence = request.sequence;
    running = true;
    try {
      let data: unknown;
      if (request.action.startsWith('bridge-')) {
        const extension = vscode.extensions.getExtension<{ client: { diagnostics: object } }>(
          'devloom.devloom-bootstrap',
        );
        assert.ok(extension || request.action === 'bridge-status');
        if (request.action === 'bridge-write') {
          await context.globalState.update('normal', fixture.nonce);
          await context.workspaceState.update('normal', fixture.nonce);
        } else if (request.action === 'bridge-verify')
          data = await bounded(
            vscode.commands.executeCommand('devloom.verifyLocalBridge'),
            'normal Rust verify',
          );
        else if (request.action === 'bridge-stop')
          data = await bounded(
            vscode.commands.executeCommand('devloom.stopLocalBridge'),
            'normal Rust stop',
          );
        else if (request.action === 'bridge-extensions')
          data = await bounded(
            vscode.commands.executeCommand('workbench.extensions.action.showExtensionsWithIds', [
              'devloom.devloom-bootstrap',
            ]),
            'show own extension',
          );
        else if (request.action !== 'bridge-status') throw new Error('Unknown bridge action');
        data = {
          result: data ?? null,
          active: extension?.isActive ?? false,
          present: !!extension,
          extensionPath: extension?.extensionPath,
          mode: context.extensionMode,
          appRoot: process.env.DEVLOOM_APP_ROOT,
          globalState: context.globalState.get('normal') ?? null,
          workspaceState: context.workspaceState.get('normal') ?? null,
          diagnostics: extension?.isActive ? extension.exports.client.diagnostics : null,
        };
      } else
        data =
          request.action === 'quit' ? null : await scenarios.action(request.name, request.action);
      publish(`result-${request.stage}.json`, {
        status: 'pass',
        stage: request.stage,
        action: request.action,
        sequence,
        observed: Date.now(),
        data,
      });
      if (request.action === 'quit') {
        setTimeout(() => {
          void bounded(vscode.commands.executeCommand('workbench.action.quit'), 'quit').catch(
            () => {},
          );
        }, 150);
      }
    } catch (error) {
      publish(`result-${request.stage}.json`, {
        status: 'fail',
        stage: request.stage,
        action: request.action,
        sequence,
        observed: Date.now(),
        error: error instanceof Error ? error.stack : String(error),
      });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void poll().catch((error: unknown) => {
      clearInterval(timer);
      publish('poll-error.json', { status: 'fail', error: String(error) });
    });
  }, 75);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}
