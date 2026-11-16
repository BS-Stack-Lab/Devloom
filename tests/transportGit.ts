import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const digest = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');
const quote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";
export function environment(input: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = { ...input };
  for (const key of Object.keys(result)) {
    if (
      /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*|NAMESPACE|CEILING_DIRECTORIES|SSL.*|TRACE.*|CURL.*|SSH.*)$/.test(
        key,
      ) ||
      /^(https?|all|no)_proxy$/i.test(key) ||
      /^(SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|SSH_AUTH_SOCK|SSH_ASKPASS|SSH_ASKPASS_REQUIRE)$/.test(
        key,
      )
    )
      delete result[key];
  }
  return result;
}
export function privatePath(path: string, directory = false): void {
  const info = lstatSync(path);
  assert.ok(!info.isSymbolicLink() && info.uid === process.getuid?.() && !(info.mode & 0o077));
  assert.ok(directory ? info.isDirectory() : info.isFile());
}
export function adapter(directory: string, configuration: string, ssh?: string) {
  privatePath(directory, true);
  const executable = realpathSync('/opt/homebrew/bin/git');
  assert.equal(
    execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim(),
    'git version 2.53.0',
  );
  const global = join(directory, 'fixture-global');
  writeFileSync(global, configuration, { flag: 'wx', mode: 0o600 });
  const log = join(directory, 'git-executions');
  const path = join(directory, 'fixture-git');
  const script = join(directory, 'fixture-git.cjs');
  const source = `const fs = require('node:fs');
const env = (${environment.toString()})();
env.GIT_CONFIG_GLOBAL = ${JSON.stringify(global)};
env.GIT_CONFIG_NOSYSTEM = '1';
env.GIT_TERMINAL_PROMPT = '0';
${
  ssh
    ? `env.GIT_SSH_COMMAND = ${JSON.stringify(`/usr/bin/ssh -F ${quote(ssh)}`)};
env.GIT_SSH_VARIANT = 'ssh';`
    : ''
}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  pid: process.pid, argv: process.argv.slice(2), at: Date.now(),
}) + '\\n', { mode: 384 });
process.execve(${JSON.stringify(executable)}, [${JSON.stringify(executable)}, ...process.argv.slice(2)], env);
`;
  writeFileSync(script, source, { flag: 'wx', mode: 0o600 });
  writeFileSync(path, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, {
    flag: 'wx',
    mode: 0o700,
  });
  return {
    path,
    global,
    log,
    executable,
    hashes: Object.fromEntries(
      [path, global, script, executable].map((file) => [file, digest(readFileSync(file))]),
    ),
  };
}
export function git(root: string, args: string[], executable = '/opt/homebrew/bin/git'): string {
  return execFileSync(executable, args, {
    cwd: root,
    env: {
      ...environment(),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    },
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
const identity = [
  '-c',
  'user.name=Devloom fixture',
  '-c',
  'user.email=fixture@invalid',
  '-c',
  'commit.gpgsign=false',
];
export function setup(directory: string, nonce: string) {
  assert.match(nonce, /^[a-f0-9]{32}$/);
  mkdirSync(directory, { mode: 0o700 });
  const peer = join(directory, 'peer');
  const remote = join(directory, `remote-${nonce}.git`);
  mkdirSync(peer, { mode: 0o700 });
  git(peer, ['init', '-b', 'main']);
  for (const name of ['fixture.txt', 'sentinel.txt'])
    writeFileSync(join(peer, name), `${name} baseline ${nonce}\n`);
  git(peer, ['add', '.']);
  git(peer, [...identity, 'commit', '-m', `fixture ${nonce}`]);
  git(directory, ['clone', '--bare', peer, remote]);
  git(remote, ['config', 'http.receivepack', 'true']);
  writeFileSync(join(remote, 'git-daemon-export-ok'), '', { flag: 'wx', mode: 0o600 });
  return {
    peer,
    remote,
    head: git(peer, ['rev-parse', 'HEAD']),
    tree: git(peer, ['rev-parse', 'HEAD^{tree}']),
  };
}
export function peerCommit(peer: string, remote: string, nonce: string) {
  writeFileSync(join(peer, 'fixture.txt'), `peer ${nonce} ${randomBytes(8).toString('hex')}\n`);
  git(peer, ['add', 'fixture.txt']);
  git(peer, [...identity, 'commit', '-m', `peer ${nonce}`]);
  git(peer, ['push', remote, 'main']);
  return git(peer, ['rev-parse', 'HEAD']);
}
export function snapshot(root: string) {
  const index = join(root, '.git/index');
  return {
    head: git(root, ['rev-parse', 'HEAD']),
    tree: git(root, ['rev-parse', 'HEAD^{tree}']),
    index: existsSync(index) ? digest(readFileSync(index)) : null,
    entries: git(root, ['ls-files', '--stage']),
    staged: git(root, ['diff', '--cached', '--binary']),
    disk: Object.fromEntries(
      ['fixture.txt', 'sentinel.txt', 'staged.txt']
        .filter((name) => existsSync(join(root, name)))
        .map((name) => [name, digest(readFileSync(join(root, name)))]),
    ),
  };
}
export function protect(root: string, nonce: string) {
  assert.equal(readFileSync(join(root, 'staged.txt'), 'utf8'), `unstaged ${nonce}\n`);
  const before = snapshot(root);
  git(root, [...identity, 'commit', '--dry-run']);
  const after = snapshot(root);
  assert.deepEqual({ ...before, index: null }, { ...after, index: null });
  return { before, after, rawIndexChangedByPrime: before.index !== after.index };
}
export function references(remote: string): string {
  return git(remote, ['show-ref']);
}

export function objectInventory(root: string) {
  const directory = join(root, '.git/objects');
  if (!existsSync(directory)) return null;
  const queue = [directory];
  let files = 0;
  let bytes = 0;
  let concurrentChange = false;
  let visited = 0;
  while (queue.length) {
    assert.ok(++visited + files <= 10000, 'Fixture object observation bound');
    let entries;
    try {
      entries = readdirSync(queue.pop()!, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        concurrentChange = true;
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      const path = join(entry.parentPath, entry.name);
      assert.equal(entry.isSymbolicLink(), false, 'Foreign fixture object alias');
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile()) {
        try {
          bytes += lstatSync(path).size;
          files++;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') concurrentChange = true;
          else throw error;
        }
      }
    }
  }
  return { kind: 'sampled', files, bytes, concurrentChange };
}
