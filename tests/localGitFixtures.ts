import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  symlinkSync,
  cpSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { isolatedEnvironment, gitAdapter } from './commitStateGit';
export function git(cwd: string, args: string[]): string {
  let directory = cwd;
  while (
    !process.env.DEVLOOM_COMMIT_FIXTURE_GIT &&
    !existsSync(join(directory, 'fixture-git')) &&
    dirname(directory) !== directory
  )
    directory = dirname(directory);
  const executable =
    process.env.DEVLOOM_COMMIT_FIXTURE_GIT ||
    (existsSync(join(directory, 'fixture-git'))
      ? join(directory, 'fixture-git')
      : '/opt/homebrew/bin/git');
  return execFileSync(executable, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: isolatedEnvironment(),
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  }).trimEnd();
}
export function identity(root: string): void {
  const hooks = join(root, '.git/devloom-fixture-hooks');
  mkdirSync(hooks, { recursive: true });
  git(root, ['config', 'core.hooksPath', hooks]);
  git(root, ['config', 'user.name', 'Devloom Fixture']);
  git(root, ['config', 'user.email', 'fixture@invalid.local']);
  git(root, ['config', 'commit.gpgsign', 'false']);
}
export const baseline = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join('');
export const changed = baseline
  .replace('line 2\n', 'selected change\n')
  .replace('line 25\n', 'remaining change\n');
export const selected = baseline.replace('line 2\n', 'selected change\n');
export function setupFixture(root: string): void {
  gitAdapter(root);
  const repository = join(root, 'repository');
  mkdirSync(repository);
  git(repository, ['init', '-b', 'main']);
  identity(repository);
  writeFileSync(join(repository, 'fixture.txt'), baseline);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'baseline']);
  git(root, ['init', '--bare', 'remote.git']);
  git(repository, ['remote', 'add', 'origin', join(root, 'remote.git')]);
  git(repository, ['push', '-u', 'origin', 'main']);
  git(join(root, 'remote.git'), ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(root, ['clone', join(root, 'remote.git'), 'peer']);
  identity(join(root, 'peer'));
}
export function snapshot(root: string): object {
  return {
    head: git(root, ['rev-parse', 'HEAD']),
    parents: git(root, ['log', '-1', '--format=%P']),
    index: git(root, ['ls-files', '--stage']),
    status: git(root, ['status', '--porcelain=v1']),
    file: readFileSync(join(root, 'fixture.txt'), 'utf8'),
  };
}

export function prepareConcurrent(root: string, alias: boolean): string {
  const hooks = join(root, 'hooks');
  mkdirSync(hooks);
  git(join(root, 'repository'), ['config', 'core.hooksPath', hooks]);
  const hook = join(hooks, 'pre-commit');
  writeFileSync(
    hook,
    `#!/bin/sh\nprintf ready > '${join(root, 'hook-ready')}'\nwhile ! test -f '${join(root, 'release')}'; do sleep 0.1; done\n`,
  );
  chmodSync(hook, 0o700);
  let second = join(root, 'repository');
  if (alias) {
    git(second, ['worktree', 'add', '-b', 'linked', join(root, 'linked')]);
    symlinkSync(join(root, 'linked'), join(root, 'alias'));
    second = join(root, 'alias');
  }
  return second;
}

export function configureScenario(root: string, profile: string): void {
  if (profile === 'missing') {
    const bin = join(root, 'no-git-bin');
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, 'node'));
    symlinkSync('/bin/bash', join(bin, 'bash'));
    symlinkSync('/usr/bin/dirname', join(bin, 'dirname'));
  }
  if (profile === 'unsupported') {
    const actualGit = join(root, 'fixture-git');
    const fake = join(root, 'old-git');
    writeFileSync(
      fake,
      `#!/bin/sh\nif test "$1" = --version; then printf 'git version 2.0.0\\n'; exit 0; fi\nexec '${actualGit}' "$@"\n`,
    );
    chmodSync(fake, 0o700);
  }
  if (profile === 'untrusted') {
    const marker = join(root, 'execution-marker');
    const helper = join(root, 'execution-helper');
    writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(helper, 0o700);
    cpSync(helper, join(root, 'repository/.git/devloom-fixture-hooks/pre-commit'));
    git(join(root, 'repository'), ['config', 'filter.fixture.clean', helper]);
    git(join(root, 'repository'), ['config', 'diff.fixture.textconv', helper]);
    writeFileSync(join(root, 'repository/.gitattributes'), '* filter=fixture diff=fixture\n');
  }
}
