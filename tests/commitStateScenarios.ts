import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { API, Repository } from '../vendor/code-oss/extensions/git/src/api/git';
import {
  cases,
  contents,
  digest,
  draft,
  fileNames,
  snapshot,
  template,
} from './commitStateFixtures';

export async function bounded<T>(
  operation: Thenable<T>,
  label: string,
  timeout = 10000,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Native operation timeout: ${label}`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export class Scenarios {
  private api!: API;
  private repositories = new Map<string, Repository>();
  private collateral = () =>
    Object.fromEntries(
      cases.map((name) => {
        const root = this.repository(name).rootUri.fsPath;
        return [
          name,
          {
            head: readFileSync(join(root, '.git/refs/heads/main'), 'utf8'),
            index: digest(readFileSync(join(root, '.git/index'))),
          },
        ];
      }),
    );
  private operations = new Map<
    string,
    { state: string; error?: string; started: number; finished?: number }
  >();
  constructor(
    private workspace: string,
    private nonce: string,
  ) {}
  async initialize(): Promise<void> {
    const extension = vscode.extensions.getExtension<{ getAPI(version: number): API }>(
      'vscode.git',
    );
    assert.ok(extension);
    this.api = (await bounded(extension.activate(), 'activate Git')).getAPI(1);
    for (const name of cases) {
      const repository = await bounded(
        this.api.openRepository(vscode.Uri.file(join(this.workspace, name))),
        `open ${name}`,
      );
      assert.ok(repository);
      this.repositories.set(name, repository);
    }
    await bounded(vscode.commands.executeCommand('workbench.view.scm'), 'mount SCM');
  }
  private repository(name: string): Repository {
    const value = this.repositories.get(name);
    assert.ok(value, 'Unknown fixture case');
    return value;
  }
  async observe(name: string) {
    const repository = this.repository(name);
    const root = repository.rootUri.fsPath;
    const documents = vscode.workspace.textDocuments
      .filter(
        (document) => document.uri.scheme === 'file' && document.uri.fsPath.startsWith(`${root}/`),
      )
      .map((document) => ({
        uri: document.uri.toString(),
        version: document.version,
        dirty: document.isDirty,
        text: document.getText(),
        sha256: digest(document.getText()),
      }));
    return {
      name,
      root,
      draft: repository.inputBox.value,
      git: snapshot(root, this.nonce),
      documents,
      operation: this.operations.get(name) ?? null,
      repositories: this.collateral(),
    };
  }
  async action(name: string, action: string): Promise<unknown> {
    const repository = this.repository(name);
    const root = repository.rootUri.fsPath;
    if (action === 'prepare') {
      await bounded(repository.status(), 'status');
      const names =
        name === 'plural' ? fileNames(this.nonce).slice(0, 2) : [fileNames(this.nonce)[0]];
      for (const file of names) {
        const document = await bounded(
          vscode.workspace.openTextDocument(vscode.Uri.file(join(root, file))),
          'open dirty file',
        );
        await bounded(
          vscode.window.showTextDocument(document, { preview: false }),
          'show dirty file',
        );
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          document.uri,
          new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
          contents(this.nonce, file).B,
        );
        assert.equal(await bounded(vscode.workspace.applyEdit(edit), 'edit buffer'), true);
        assert.equal(document.isDirty, true);
      }
      if (name === 'scope') {
        const outside = await bounded(
          vscode.workspace.openTextDocument({ content: `untitled ${this.nonce}` }),
          'untitled',
        );
        await bounded(vscode.window.showTextDocument(outside, { preview: false }), 'show untitled');
        const uri = vscode.Uri.file(join(this.workspace, `outside-${this.nonce}.txt`));
        writeFileSync(uri.fsPath, 'outside disk\n');
        const document = await bounded(vscode.workspace.openTextDocument(uri), 'outside');
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), `outside dirty ${this.nonce}\n`);
        assert.equal(await bounded(vscode.workspace.applyEdit(edit), 'outside edit'), true);
        await bounded(vscode.window.showTextDocument(document, { preview: false }), 'show outside');
      }
      repository.inputBox.value = draft(this.nonce, name);
      await bounded(
        vscode.workspace
          .getConfiguration('git')
          .update(
            'promptToSaveFilesBeforeCommit',
            name === 'never' ? 'never' : 'always',
            vscode.ConfigurationTarget.Global,
          ),
        'warning setting',
      );
    } else if (action === 'backup-change') {
      const uri = vscode.Uri.file(join(root, fileNames(this.nonce)[0]));
      const document = vscode.workspace.textDocuments.find(
        (item) => item.uri.toString() === uri.toString(),
      );
      assert.ok(document?.isDirty);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(
        uri,
        document.positionAt(document.getText().length),
        `backup refusal ${this.nonce}\n`,
      );
      assert.equal(await bounded(vscode.workspace.applyEdit(edit), 'change blocked backup'), true);
    } else if (action === 'template-change') {
      assert.equal(repository.inputBox.value, draft(this.nonce, name));
      writeFileSync(join(root, '.git/template'), `${template(this.nonce)}\nchanged`);
      await bounded(repository.status(), 'template refresh');
    } else if (action === 'commit') {
      assert.ok(!this.operations.has(name) || this.operations.get(name)?.state === 'done');
      const operation = { state: 'pending', started: Date.now() } as {
        state: string;
        error?: string;
        started: number;
        finished?: number;
      };
      this.operations.set(name, operation);
      void bounded(
        vscode.commands.executeCommand('git.commit', repository.rootUri),
        'git.commit',
        40000,
      ).then(
        () => {
          operation.state = 'done';
          operation.finished = Date.now();
        },
        (error: unknown) => {
          operation.state = 'done';
          operation.error = String(error);
          operation.finished = Date.now();
        },
      );
    } else if (action === 'release') {
      assert.equal(name, 'held');
      assert.ok(existsSync(join(root, '.git/invocations')));
      writeFileSync(join(root, '.git/release'), 'release\n', { flag: 'wx' });
    } else if (action === 'retry') {
      assert.equal(name, 'failure');
      unlinkSync(join(root, '.git/hooks-owned/pre-commit'));
    } else if (action === 'mount') {
      await bounded(vscode.commands.executeCommand('workbench.view.scm'), 'mount SCM');
      await bounded(
        vscode.commands.executeCommand('git.openRepository', root),
        'select repository',
      );
    } else if (action !== 'read') throw new Error('Unknown scenario action');
    return this.observe(name);
  }
}
