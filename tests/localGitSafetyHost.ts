import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { API, CloneOptions, Repository } from '../vendor/code-oss/extensions/git/src/api/git';
import { git, snapshot } from './localGitFixtures';
interface Trace {
  event: string;
  at: number;
  pid?: number;
  command?: string;
}
interface Diagnostic {
  coordinator: { state: string; events: Trace[] };
}
type NativeRepository = Repository & { diagnoseLocalGit(): Promise<Diagnostic> };
type CancellableAPI = API & {
  clone(
    uri: vscode.Uri,
    options: CloneOptions | undefined,
    token: vscode.CancellationToken,
  ): Promise<vscode.Uri | null>;
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(path: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error('Controlled clone rendezvous timed out');
    await delay(20);
  }
}
export async function verifyRouting(root: string, repository: Repository): Promise<object> {
  const a = join(root, 'repository');
  const b = join(root, 'peer');
  const aIndex = readFileSync(join(a, '.git/index'));
  const bIndex = readFileSync(join(b, '.git/index'));
  const aState = snapshot(a);
  const bState = snapshot(b);
  const cases = [
    {
      environment: { GIT_INDEX_FILE: join(b, '.git/index') },
      action: () => repository.add([join(a, 'fixture.txt')]),
    },
    {
      environment: { GIT_DIR: join(b, '.git') },
      action: () => repository.buffer('HEAD', 'fixture.txt'),
    },
    { environment: { GIT_WORK_TREE: b }, action: () => repository.add([join(a, 'fixture.txt')]) },
    {
      environment: { GIT_COMMON_DIR: join(b, '.git') },
      action: () => repository.getConfig('user.name'),
    },
    {
      environment: { GIT_OBJECT_DIRECTORY: join(b, '.git/objects') },
      action: () => repository.hashObject('forbidden object'),
    },
    {
      environment: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.worktree',
        GIT_CONFIG_VALUE_0: b,
      },
      action: () => repository.add([join(a, 'fixture.txt')]),
    },
  ];
  for (const item of cases) {
    const previous = new Map(Object.keys(item.environment).map((key) => [key, process.env[key]]));
    try {
      Object.assign(process.env, item.environment);
      await assert.rejects(item.action, /Unsupported Git routing environment/);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    assert.deepEqual(readFileSync(join(a, '.git/index')), aIndex);
    assert.deepEqual(readFileSync(join(b, '.git/index')), bIndex);
  }
  await assert.rejects(repository.setConfig('core.worktree', b), /routing Git configuration/);
  assert.deepEqual(snapshot(a), aState);
  assert.deepEqual(snapshot(b), bState);
  await repository.status();
  return { refused: cases.map((item) => Object.keys(item.environment)), a: aState, b: bState };
}
export async function verifyCloneCancellation(
  root: string,
  api: API,
  repository: Repository,
): Promise<object> {
  const parent = join(root, 'cancel-parent');
  mkdirSync(parent);
  const sentinel = join(parent, 'existing-file.txt');
  writeFileSync(sentinel, 'preexisting fixture bytes\n');
  const ready = join(root, 'cancel-ready');
  const release = join(root, 'cancel-release');
  const helper = join(root, 'local-upload-pack');
  const uploadPack = join(git(root, ['--exec-path']), 'git-upload-pack');
  writeFileSync(
    helper,
    `#!/bin/sh\nprintf '%s' "$$" > '${ready}'\ntrap 'exit 143' TERM INT\nwhile ! test -f '${release}'; do /bin/sleep 0.05; done\nexec '${uploadPack}' '${join(root, 'remote.git')}'\n`,
  );
  chmodSync(helper, 0o700);
  const state = snapshot(join(root, 'repository'));
  const index = readFileSync(join(root, 'repository/.git/index'));
  const remote = git(join(root, 'remote.git'), ['rev-parse', 'HEAD']);
  const previousCommand = process.env.GIT_SSH_COMMAND;
  const previousVariant = process.env.GIT_SSH_VARIANT;
  const source = new vscode.CancellationTokenSource();
  const destination = join(parent, 'cancel-source');
  let settled = false;
  try {
    process.env.GIT_SSH_COMMAND = helper;
    process.env.GIT_SSH_VARIANT = 'ssh';
    const operation = (api as CancellableAPI).clone(
      vscode.Uri.parse('ssh://devloom-fixture/cancel-source.git'),
      { parentPath: vscode.Uri.file(parent), postCloneAction: 'none' },
      source.token,
    );
    const observed = operation.then(
      (value) => {
        settled = true;
        return { value, error: undefined };
      },
      (error: Error) => {
        settled = true;
        return { value: undefined, error };
      },
    );
    await wait(ready);
    assert.ok(existsSync(join(destination, '.git')));
    const before = await (repository as NativeRepository).diagnoseLocalGit();
    assert.equal(before.coordinator.state, 'active');
    const started = before.coordinator.events
      .slice()
      .reverse()
      .find((event) => event.event === 'child-start' && event.command === 'clone');
    assert.ok(started?.pid);
    source.cancel();
    await delay(100);
    const settledBeforeRelease = settled;
    const during = await (repository as NativeRepository).diagnoseLocalGit();
    if (!settled) assert.equal(during.coordinator.state, 'active');
    writeFileSync(release, 'release owned helper');
    const outcome = await observed;
    assert.equal(outcome.value, undefined);
    assert.match(outcome.error?.message || '', /quarantined/);
    const after = await (repository as NativeRepository).diagnoseLocalGit();
    assert.equal(after.coordinator.state, 'quarantined');
    const closed = after.coordinator.events
      .slice()
      .reverse()
      .find((event) => event.event === 'child-close' && event.pid === started.pid);
    const releasing = after.coordinator.events
      .slice()
      .reverse()
      .find((event) => event.event === 'release-request');
    assert.ok(closed && releasing && closed.at <= releasing.at);
    const journal = JSON.parse(
      readFileSync(join(process.env.DEVLOOM_GIT_TEST_DIRECTORY!, 'ownership.json'), 'utf8'),
    );
    assert.equal(journal.record.state, 'quarantined');
    assert.equal(readFileSync(sentinel, 'utf8'), 'preexisting fixture bytes\n');
    assert.deepEqual(readFileSync(join(root, 'repository/.git/index')), index);
    assert.deepEqual(snapshot(join(root, 'repository')), state);
    assert.equal(git(join(root, 'remote.git'), ['rev-parse', 'HEAD']), remote);
    if (existsSync(destination))
      assert.throws(() => git(destination, ['rev-parse', '--verify', 'HEAD']));
    await repository.status();
    await assert.rejects(repository.add([join(root, 'repository/fixture.txt')]), /quarantined/);
    assert.deepEqual(snapshot(join(root, 'repository')), state);
    return {
      settledBeforeRelease,
      before,
      during,
      after,
      journal,
      destinationExists: existsSync(destination),
      existingFile: readFileSync(sentinel, 'utf8'),
      original: state,
      remote,
    };
  } finally {
    writeFileSync(release, 'cleanup owned helper');
    source.dispose();
    if (previousCommand === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = previousCommand;
    if (previousVariant === undefined) delete process.env.GIT_SSH_VARIANT;
    else process.env.GIT_SSH_VARIANT = previousVariant;
  }
}
