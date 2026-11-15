import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isReadOnly, validateEnvironment } from '../product/localGit/commandPolicy';
import { MutationBroker } from '../product/localGit/mutationBroker';
import { MutationClient, assertSpawn, track } from '../product/localGit/mutationClient';
import { capture } from '../product/localGit/snapshot';
import { setupFixture, git } from './localGitFixtures';
test('effective Git routing environment and config override vectors fail closed', () => {
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
    'GIT_QUARANTINE_PATH',
    'GIT_SHALLOW_FILE',
    'GIT_GRAFT_FILE',
    'GIT_CONFIG',
    'GIT_CONFIG_SYSTEM',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
  ])
    assert.throws(() => validateEnvironment({ [key]: '/fixture/other' }), /routing environment/);
  assert.throws(() => validateEnvironment({ GIT_CONFIG_COUNT: '1' }), /routing environment/);
  validateEnvironment({
    GIT_CONFIG_COUNT: '0',
    GIT_ASKPASS: 'askpass',
    SSH_AUTH_SOCK: 'socket',
    GIT_SSH_COMMAND: 'transport',
    GIT_HTTP_USER_AGENT: 'fixture',
  });
  for (const key of [
    'core.worktree',
    'core.bare',
    'include.path',
    'includeIf.gitdir.path',
    'extensions.worktreeConfig',
    'extensions.refStorage',
  ])
    assert.throws(
      () => isReadOnly(['-c', `${key}=/fixture/other`, 'status']),
      /configuration override/,
    );
  for (const args of [
    ['clone', '--config=core.worktree=/other', 'source', 'target'],
    ['clone', '-ccore.worktree=/other', 'source', 'target'],
    ['init', '--separate-git-dir=/other'],
    ['config', '--local', 'core.worktree', '/other'],
  ])
    assert.throws(() => isReadOnly(args), /routing|configuration/);
  assert.equal(isReadOnly(['-c', 'i18n.logOutputEncoding=UTF-8', 'log', '-1']), true);
  assert.equal(isReadOnly(['rev-parse', '--git-dir', '--git-common-dir']), true);
  assert.equal(isReadOnly(['-c', 'user.useConfigOnly=true', 'commit', '-m', 'fixture']), false);
});
test('A/B real Git reproduction is fenced and normal authenticated environment retains A ownership', async () => {
  const root = mkdtempSync('/tmp/dlp-');
  setupFixture(root);
  const a = join(root, 'repository');
  const b = join(root, 'peer');
  const bPath = join(b, '.git/index');
  const originalB = readFileSync(bPath);
  writeFileSync(join(a, 'routing.ts'), 'A-only bytes\n');
  const broker = new MutationBroker(join(root, 'broker'));
  await broker.listen();
  try {
    execFileSync('git', ['add', 'routing.ts'], {
      cwd: a,
      env: { ...process.env, GIT_INDEX_FILE: bPath },
      stdio: 'pipe',
    });
    assert.notDeepEqual(readFileSync(bPath), originalB);
    assert.match(git(a, ['status', '--porcelain']), /\?\? routing.ts/);
    writeFileSync(bPath, originalB);
    const client = new MutationClient(join(root, 'broker'));
    await client.run(capture(a), 'repository', async () => {
      assert.throws(
        () =>
          assertSpawn(['add', 'routing.ts'], true, a, { ...process.env, GIT_INDEX_FILE: bPath }),
        /routing environment/,
      );
      assert.deepEqual(readFileSync(bPath), originalB);
      const environment = {
        ...process.env,
        GIT_ASKPASS: 'fixture-askpass',
        SSH_AUTH_SOCK: 'fixture-socket',
        GIT_SSH_COMMAND: 'fixture-transport',
      };
      assert.equal(assertSpawn(['add', 'routing.ts'], true, a, environment), false);
      const child = spawn('git', ['add', 'routing.ts'], {
        cwd: a,
        env: environment,
        stdio: 'ignore',
      });
      track(child, 'add');
      assert.equal(await new Promise((resolve) => child.once('close', resolve)), 0);
    });
    assert.match(git(a, ['ls-files']), /routing.ts/);
    assert.deepEqual(readFileSync(bPath), originalB);
    assert.equal((await client.diagnose()).state, 'ready');
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
