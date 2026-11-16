import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { API, CloneOptions, Repository } from '../vendor/code-oss/extensions/git/src/api/git';
import { snapshot, protect, digest, git, objectInventory } from './transportGit';

type CancellableAPI = API & {
  clone(
    uri: vscode.Uri,
    options: CloneOptions | undefined,
    token: vscode.CancellationToken,
  ): Promise<vscode.Uri | null>;
};
type DiagnosticRepository = Repository & { diagnoseLocalGit(): Promise<unknown> };
export type TransportFixture = {
  nonce: string;
  session: string;
  channel: string;
  workspace: string;
  profile: string;
  sourceDigest: string;
  url: string;
  credentialPath?: string;
  repository: string;
  clones: string;
};
export class Scenarios {
  private api!: API;
  private repository!: Repository;
  private source?: vscode.CancellationTokenSource;
  private operation: {
    state: string;
    action: string;
    started: number;
    finished?: number;
    error?: string;
    destination?: string | null;
  } | null = null;
  private calls: { scheme: string; authority: string; at: number }[] = [];
  constructor(
    private fixture: TransportFixture,
    private context: vscode.ExtensionContext,
  ) {}
  async initialize(): Promise<void> {
    const extension = vscode.extensions.getExtension<{ getAPI(version: number): API }>(
      'vscode.git',
    );
    assert.ok(extension);
    this.api = (await extension.activate()).getAPI(1);
    const endpoint = vscode.Uri.parse(this.fixture.url);
    if (endpoint.scheme === 'https') {
      assert.equal(endpoint.authority, `127.0.0.1:${new URL(this.fixture.url).port}`);
      this.context.subscriptions.push(
        this.api.registerCredentialsProvider({
          getCredentials: (host) => {
            this.calls.push({ scheme: host.scheme, authority: host.authority, at: Date.now() });
            if (host.scheme !== endpoint.scheme || host.authority !== endpoint.authority)
              return undefined;
            assert.ok(this.fixture.credentialPath);
            const credentials = JSON.parse(readFileSync(this.fixture.credentialPath, 'utf8')) as {
              username: string;
              password: string;
            };
            assert.match(credentials.username, /^[a-f0-9]{32}$/);
            assert.match(credentials.password, /^[a-f0-9]{64}$/);
            return credentials;
          },
        }),
      );
    }
    const repository = await this.api.openRepository(vscode.Uri.file(this.fixture.repository));
    assert.ok(repository);
    this.repository = repository;
    this.repository.inputBox.value = `transport draft ${this.fixture.nonce}\nsecond line`;
    await vscode.commands.executeCommand('workbench.view.scm');
  }
  async observe() {
    return {
      objects: objectInventory(this.repository.rootUri.fsPath),
      cloneObjects: objectInventory(
        join(
          this.fixture.clones,
          basename(new URL(this.fixture.url).pathname).replace(/\.git$/, ''),
        ),
      ),
      operation: this.operation,
      credentials: this.calls,
      state: snapshot(this.repository.rootUri.fsPath),
      draft: this.repository.inputBox.value,
      native: { head: this.repository.state.HEAD, remotes: this.repository.state.remotes },
      diagnostic: await (this.repository as DiagnosticRepository).diagnoseLocalGit(),
      destinationExists: existsSync(
        join(
          this.fixture.clones,
          basename(new URL(this.fixture.url).pathname).replace(/\.git$/, ''),
        ),
      ),
    };
  }
  async action(action: string): Promise<unknown> {
    if (action === 'read') return this.observe();
    if (action === 'connect') {
      await this.repository.unsetConfig('remote.origin.url');
      await this.repository.setConfig('remote.origin.url', this.fixture.url);
      assert.equal(
        git(this.repository.rootUri.fsPath, ['config', '--get-all', 'remote.origin.url']),
        this.fixture.url,
      );
      await this.repository.status();
      return this.observe();
    }
    if (action === 'cancel') {
      assert.ok(this.source);
      this.source.cancel();
      return this.observe();
    }
    if (action === 'protect') {
      const staged = join(this.repository.rootUri.fsPath, 'staged.txt');
      writeFileSync(staged, `staged ${this.fixture.nonce}\n`);
      await this.repository.add([staged]);
      writeFileSync(staged, `unstaged ${this.fixture.nonce}\n`);
      await this.repository.status();
      const prime = protect(this.repository.rootUri.fsPath, this.fixture.nonce);
      await this.repository.status();
      return { prime, ...(await this.observe()) };
    }
    if (action === 'use-clone') {
      assert.ok(this.operation?.destination);
      const opened = await this.api.openRepository(vscode.Uri.file(this.operation.destination));
      assert.ok(opened);
      this.repository = opened;
      return this.observe();
    }
    if (action === 'commit' || action === 'large-commit') {
      assert.ok(this.operation?.state !== 'pending');
      const file = join(
        this.repository.rootUri.fsPath,
        action === 'large-commit' ? 'large.bin' : 'client.txt',
      );
      const bytes =
        action === 'large-commit'
          ? Buffer.from(
              Array.from({ length: 2 * 1024 * 1024 }, () => Math.floor(Math.random() * 256)),
            )
          : Buffer.from(`native ${this.fixture.nonce}\n`);
      writeFileSync(file, bytes);
      await this.repository.add([file]);
      await this.repository.commit(`native transport ${this.fixture.nonce}`);
      return { contentHash: digest(bytes), ...(await this.observe()) };
    }
    if (action === 'refused-write') {
      await assert.rejects(
        this.repository.add([join(this.repository.rootUri.fsPath, 'fixture.txt')]),
        /quarantined/,
      );
      return this.observe();
    }
    assert.ok(['clone', 'fetch', 'pull', 'push'].includes(action));
    assert.ok(this.operation?.state !== 'pending');
    const operation = { state: 'pending', action, started: Date.now() } as NonNullable<
      typeof this.operation
    >;
    this.operation = operation;
    this.source = new vscode.CancellationTokenSource();
    const promise =
      action === 'clone'
        ? (this.api as CancellableAPI).clone(
            vscode.Uri.parse(this.fixture.url),
            { parentPath: vscode.Uri.file(this.fixture.clones), postCloneAction: 'none' },
            this.source.token,
          )
        : action === 'fetch'
          ? this.repository.fetch('origin')
          : action === 'pull'
            ? this.repository.pull(false)
            : this.repository.push('origin', 'main', true);
    void Promise.resolve(promise)
      .then(
        (value) => {
          if (action === 'clone')
            operation.destination = value instanceof vscode.Uri ? value.fsPath : null;
        },
        (error: unknown) => {
          const failure = error as {
            message?: string;
            stderr?: string;
            gitErrorCode?: string;
            exitCode?: number;
          };
          operation.error = [failure.message ?? String(error), failure.stderr, failure.gitErrorCode]
            .filter(Boolean)
            .join('\n');
        },
      )
      .finally(() => {
        operation.state = 'done';
        operation.finished = Date.now();
        this.source?.dispose();
      });
    return this.observe();
  }
}
