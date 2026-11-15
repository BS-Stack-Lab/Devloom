import * as vscode from 'vscode';
interface NativeRepository {
  rootUri: vscode.Uri;
  getConfig(key: string): Promise<string>;
  diagnoseLocalGit(): Promise<object>;
}
interface NativeAPI {
  git: { path: string; version: string };
  repositories: NativeRepository[];
}
export function registerLocalGit(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Devloom Local Git');
  context.subscriptions.push(output);
  context.subscriptions.push(
    vscode.commands.registerCommand('devloom.diagnoseLocalGit', async (resource?: vscode.Uri) => {
      const result: Record<string, unknown> = { trusted: vscode.workspace.isTrusted };
      try {
        if (!vscode.workspace.isTrusted) {
          result.action = 'Trust the workspace before running repository Git.';
        } else {
          const extension = vscode.extensions.getExtension('vscode.git');
          if (!extension) throw new Error('Bundled Git unavailable');
          const exported = (await extension.activate()) as { getAPI(version: number): NativeAPI };
          const api = exported.getAPI(1);
          result.executable = api.git.path;
          result.version = api.git.version;
          if (!result.executable || !result.version) throw new Error('Git unavailable');
          const version = api.git.version.split('.').map(Number);
          result.supported = version[0] > 2 || (version[0] === 2 && version[1] >= 28);
          if (!result.supported)
            result.action = 'Install Git 2.28 or later and reload this window.';
          const active = resource?.fsPath || vscode.window.activeTextEditor?.document.uri.fsPath;
          let repository = api.repositories.find(
            (item) =>
              active === item.rootUri.fsPath || active?.startsWith(item.rootUri.fsPath + '/'),
          );
          if (!repository && api.repositories.length === 1) repository = api.repositories[0];
          if (!repository && api.repositories.length > 1) {
            const choice = await vscode.window.showQuickPick(
              api.repositories.map((item) => ({ label: item.rootUri.fsPath, repository: item })),
              { title: 'Diagnose Local Git Repository' },
            );
            repository = choice?.repository;
          }
          if (!repository && result.supported)
            result.action = 'Open a local Git repository in Source Control.';
          else if (repository) {
            result.repository = repository.rootUri.fsPath;
            result.authorNamePresent = Boolean(
              await repository.getConfig('user.name').catch(() => ''),
            );
            result.authorEmailPresent = Boolean(
              await repository.getConfig('user.email').catch(() => ''),
            );
            try {
              result.coordinator = await repository.diagnoseLocalGit();
            } catch {
              result.action =
                'Coordinator unavailable or quarantined. Inspect OS processes and repository state. Restart does not establish safety. Do not remove Git lockfiles.';
            }
          }
        }
      } catch {
        result.action =
          'Git is unavailable. Install Git 2.28 or later, check the git.path setting, and reload this window.';
      }
      output.clear();
      output.appendLine(JSON.stringify(result, null, 2));
      output.show();
      void vscode.window
        .showInformationMessage(
          'Local Git diagnostics are available in Devloom Local Git.',
          'Open Source Control',
          'Open Git Output',
        )
        .then((choice) => {
          if (choice)
            return vscode.commands.executeCommand(
              choice === 'Open Source Control' ? 'workbench.view.scm' : 'git.showOutput',
            );
        });
      return result;
    }),
  );
}
