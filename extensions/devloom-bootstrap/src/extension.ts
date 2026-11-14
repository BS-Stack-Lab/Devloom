import * as vscode from 'vscode';
import { join } from 'node:path';
import { registerLocalGit } from './localGit';
import { BridgeClient } from './bridgeClient';
let bridge: BridgeClient | undefined;
export function activate(context: vscode.ExtensionContext) {
  registerLocalGit(context);
  bridge = new BridgeClient(
    join(
      context.extensionPath,
      '..',
      '..',
      'crates',
      'devloom-sidecar',
      'target',
      'debug',
      process.platform === 'win32' ? 'devloom-sidecar.exe' : 'devloom-sidecar',
    ),
  );
  const client = bridge;
  const output = vscode.window.createOutputChannel('Devloom');
  context.subscriptions.push(output);
  context.subscriptions.push(
    vscode.commands.registerCommand('devloom.verifyLocalBridge', async () => {
      try {
        const hello = client.state === 'ready' ? undefined : await client.start();
        const text = '한글 e\u0301 👨‍👩‍👧‍👦\nDevloom';
        const echo = await client.request('echo', { text });
        const result = { hello, echo, ...client.diagnostics };
        output.appendLine(`Bridge verified: generation ${client.generation}`);
        return result;
      } catch (error) {
        output.appendLine(`Bridge failed: ${client.state}`);
        throw error;
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('devloom.restartLocalBridge', () => client.restart()),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('devloom.stopLocalBridge', () => client.stop()),
  );
  return { client };
}
export async function deactivate(): Promise<void> {
  await bridge?.stop();
  bridge = undefined;
}
