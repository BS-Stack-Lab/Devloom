import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export function isolatedEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*|NAMESPACE|CEILING_DIRECTORIES)$/.test(
        key,
      )
    )
      delete env[key];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
}
export function git(root: string, args: string[]): string {
  return execFileSync(process.env.DEVLOOM_COMMIT_FIXTURE_GIT || 'git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
export function gitAdapter(temporary: string) {
  const executable = realpathSync('/opt/homebrew/bin/git');
  const version = execFileSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4096,
  }).trim();
  assert.equal(version, 'git version 2.53.0');
  const global = join(temporary, 'empty-global');
  writeFileSync(global, '', { flag: 'wx', mode: 0o600 });
  const log = join(temporary, 'git-executions');
  const adapter = join(temporary, 'fixture-git');
  const quote = (path: string) => "'" + path.replace(/'/g, "'\\''") + "'";
  const content = `#!/bin/sh\nprintf '%s\\0' "$$" "$#" "$@" >> ${quote(log)}\nGIT_CONFIG_GLOBAL=${quote(global)} GIT_CONFIG_NOSYSTEM=1 exec ${quote(executable)} "$@"\n`;
  writeFileSync(adapter, content, { flag: 'wx', mode: 0o700 });
  const metadata = {
    executable,
    version,
    executableHash: digest(readFileSync(executable)),
    adapter,
    adapterHash: digest(content),
    content,
    global,
    log,
  };
  assert.equal(
    execFileSync(adapter, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 4096,
    }).trim(),
    version,
  );
  for (const path of [adapter, global]) {
    const stat = lstatSync(path);
    assert.ok(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.uid === process.getuid?.() &&
        !(stat.mode & 0o077),
    );
  }
  return metadata;
}

export function adapterEvidence(adapter: ReturnType<typeof gitAdapter>) {
  assert.equal(digest(readFileSync(adapter.adapter)), adapter.adapterHash);
  assert.equal(digest(readFileSync(adapter.executable)), adapter.executableHash);
  assert.equal(readFileSync(adapter.global, 'utf8'), '');
  const raw = readFileSync(adapter.log);
  const fields = raw.toString().split('\0');
  fields.pop();
  const invocations = [];
  while (fields.length) {
    const pid = Number(fields.shift());
    const count = Number(fields.shift());
    assert.ok(pid > 1 && Number.isSafeInteger(count) && count >= 0 && count < 100);
    assert.ok(fields.length >= count);
    invocations.push({ pid, argv: fields.splice(0, count) });
  }
  return { ...adapter, invocations, invocationsBase64: raw.toString('base64') };
}
