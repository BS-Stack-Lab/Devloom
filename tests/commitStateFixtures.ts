import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './commitStateGit';
export { isolatedEnvironment, gitAdapter, adapterEvidence } from './commitStateGit';

export const cases = [
  'cancel',
  'index',
  'save',
  'plural',
  'scope',
  'never',
  'failure',
  'held',
  'restart',
];
export const digest = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');
export function contents(nonce: string, name: string): Record<string, string> {
  const base = Array.from({ length: 12 }, (_, i) => `${nonce} ${name} line ${i}\n`).join('');
  const index = base.replace('line 1\n', 'INDEX I\n');
  const disk = index.replace('line 9\n', 'DISK D\n');
  return { H: base, I: index, D: disk, B: disk.replace('line 5\n', 'BUFFER B\n') };
}
export const fileNames = (nonce: string): string[] => [
  `partial-${nonce}.txt`,
  `second-${nonce}.txt`,
  'sentinel.txt',
];
export const template = (nonce: string): string => `템플릿 ${nonce}\n\n설명 🌿`;
export const draft = (nonce: string, name: string): string =>
  `제목 ${name} ${nonce}\n\n여러 줄 🌿\n마지막 줄`;
export function setup(root: string, nonce: string) {
  const initialization = [];
  mkdirSync(root, { mode: 0o700 });
  for (const name of cases) {
    const repo = join(root, name);
    mkdirSync(repo, { mode: 0o700 });
    git(repo, ['init', '-b', 'main']);
    const hooks = join(repo, '.git/hooks-owned');
    mkdirSync(hooks, { mode: 0o700 });
    for (const [key, value] of Object.entries({
      'user.name': 'Devloom Synthetic Fixture',
      'user.email': 'fixture@invalid.local',
      'commit.gpgsign': 'false',
      'core.hooksPath': hooks,
    }))
      git(repo, ['config', '--local', key, value]);
    for (const file of fileNames(nonce)) writeFileSync(join(repo, file), contents(nonce, file).H);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', `baseline ${nonce}`]);
    const staged =
      name === 'scope'
        ? [fileNames(nonce)[1]]
        : name === 'plural'
          ? fileNames(nonce).slice(0, 2)
          : [fileNames(nonce)[0]];
    for (const file of staged) {
      writeFileSync(join(repo, file), contents(nonce, file).I);
      git(repo, ['add', file]);
      writeFileSync(join(repo, file), contents(nonce, file).D);
    }
    if (name === 'scope')
      writeFileSync(join(repo, fileNames(nonce)[0]), contents(nonce, fileNames(nonce)[0]).D);
    const before = snapshot(repo, nonce);
    const beforeIndex = readFileSync(join(repo, '.git/index')).toString('base64');
    const command = ['commit', '--dry-run', '--quiet', '-m', `fixture index preparation ${nonce}`];
    git(repo, command);
    const after = snapshot(repo, nonce);
    assert.equal(after.head, before.head);
    assert.equal(after.entries, before.entries);
    initialization.push({
      name,
      command,
      before,
      after,
      beforeIndex,
      afterIndex: readFileSync(join(repo, '.git/index')).toString('base64'),
    });
    const path = join(repo, '.git/template');
    writeFileSync(path, template(nonce));
    git(repo, ['config', '--local', 'commit.template', path]);
    if (name === 'failure' || name === 'held') {
      const hook = join(hooks, 'pre-commit');
      const script =
        name === 'failure'
          ? 'exit 1\n'
          : `i=0\nwhile ! test -f '${join(repo, '.git/release')}'; do\n i=$((i+1))\n if test "$i" -ge 140; then exit 1; fi\n sleep 0.1\ndone\n`;
      writeFileSync(
        hook,
        `#!/bin/sh\nprintf 'invoked\\n' >> '${join(repo, '.git/invocations')}'\n${script}`,
        { mode: 0o700 },
      );
      chmodSync(hook, 0o700);
    }
  }
  return initialization;
}
export function snapshot(root: string, nonce: string) {
  const bytes = (value: string | Buffer) => ({
    text: value.toString(),
    sha256: digest(value),
    bytes: Buffer.byteLength(value),
  });
  const files = Object.fromEntries(
    fileNames(nonce).map((name) => [
      name,
      {
        disk: bytes(readFileSync(join(root, name))),
        index: bytes(git(root, ['show', `:${name}`])),
        head: bytes(git(root, ['show', `HEAD:${name}`])),
        indexOid: git(root, ['rev-parse', `:${name}`]).trim(),
        headOid: git(root, ['rev-parse', `HEAD:${name}`]).trim(),
      },
    ]),
  );
  return {
    head: git(root, ['rev-parse', 'HEAD']).trim(),
    tree: git(root, ['rev-parse', 'HEAD^{tree}']).trim(),
    indexHash: digest(readFileSync(join(root, '.git/index'))),
    indexBase64: readFileSync(join(root, '.git/index')).toString('base64'),
    entries: git(root, ['ls-files', '--stage']),
    message: git(root, ['log', '-1', '--format=%B']),
    rawCommit: git(root, ['cat-file', 'commit', 'HEAD']),
    files,
    hookCount: existsSync(join(root, '.git/invocations'))
      ? readFileSync(join(root, '.git/invocations'), 'utf8').split('\n').length - 1
      : 0,
  };
}

export function verifyOwnedPath(path: string, marker: string, nonce: string): void {
  const stat = lstatSync(path);
  assert.ok(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid?.() &&
      !(stat.mode & 0o022),
  );
  const file = join(path, marker);
  const info = lstatSync(file);
  assert.ok(
    info.isFile() &&
      !info.isSymbolicLink() &&
      info.uid === process.getuid?.() &&
      !(info.mode & 0o077) &&
      info.size < 4096,
  );
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).nonce, nonce);
}
