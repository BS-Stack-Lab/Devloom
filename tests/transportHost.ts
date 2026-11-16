import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Scenarios, type TransportFixture } from './transportScenarios';

export function activate(context: vscode.ExtensionContext): void {
  const fixture = JSON.parse(
    readFileSync(join(context.extensionPath, 'fixture.json'), 'utf8'),
  ) as TransportFixture;
  assert.match(fixture.nonce, /^[a-f0-9]{32}$/);
  const metadata = {
    nonce: fixture.nonce,
    session: fixture.session,
    sourceDigest: fixture.sourceDigest,
    activation: randomUUID(),
    mainPid: Number(process.env.VSCODE_PID),
    extensionHostPid: process.pid,
    workspace: realpathSync(fixture.workspace),
    profile: fixture.profile,
    started: Date.now(),
    storageUri: context.storageUri?.fsPath,
    globalStorageUri: context.globalStorageUri.fsPath,
    appName: vscode.env.appName,
  };
  assert.ok(metadata.mainPid > 1);
  assert.equal(realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath), metadata.workspace);
  const publish = (name: string, value: object) =>
    writeFileSync(join(fixture.channel, name), JSON.stringify({ ...metadata, ...value }, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
  const scenarios = new Scenarios(fixture, context);
  let ready = false;
  let running = false;
  let sequence = 0;
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
    if (!ready || running || Date.now() - metadata.started > 600000) return;
    const file = join(fixture.channel, 'request.json');
    if (!existsSync(file)) return;
    const info = lstatSync(file);
    assert.ok(
      info.isFile() &&
        !info.isSymbolicLink() &&
        info.uid === process.getuid?.() &&
        !(info.mode & 0o077) &&
        info.size < 4096,
    );
    const request = JSON.parse(readFileSync(file, 'utf8')) as {
      nonce: string;
      session: string;
      activation: string;
      sequence: number;
      action: string;
      stage: string;
    };
    if (
      request.nonce !== fixture.nonce ||
      request.session !== fixture.session ||
      request.activation !== metadata.activation ||
      !Number.isSafeInteger(request.sequence) ||
      request.sequence <= sequence ||
      !/^[a-z0-9-]{1,64}$/.test(request.stage)
    )
      return;
    sequence = request.sequence;
    running = true;
    try {
      const data = request.action === 'quit' ? null : await scenarios.action(request.action);
      publish(`result-${request.stage}.json`, {
        ...request,
        status: 'pass',
        data,
        observed: Date.now(),
      });
      if (request.action === 'quit')
        setTimeout(() => {
          void vscode.commands.executeCommand('workbench.action.quit');
        }, 150);
    } catch (error) {
      publish(`result-${request.stage}.json`, {
        ...request,
        status: 'fail',
        error: error instanceof Error ? error.stack : String(error),
        observed: Date.now(),
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
