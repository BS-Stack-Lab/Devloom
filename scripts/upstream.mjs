import { auditPatches } from './patchUpstream.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
export const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const upstream = resolve(root, 'vendor/code-oss');
const PIN = '69047191fc427f2f92828279aae1d90d8eeda7ab';
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
export function check() {
  auditPatches(root, upstream, true);
  const lock = readJson(resolve(root, 'upstream.lock.json'));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: upstream,
    encoding: 'utf8',
  }).trim();
  const manifest = readJson(resolve(upstream, 'package.json'));
  if (
    head !== PIN ||
    lock.commit !== PIN ||
    manifest.version !== lock.version ||
    manifest.packageManager !== lock.packageManager ||
    process.version !== `v${lock.node}` ||
    readFileSync(resolve(upstream, '.nvmrc'), 'utf8').trim() !== lock.node
  )
    throw new Error('Upstream/toolchain mismatch');
  for (const path of [
    'product.json',
    'LICENSE.txt',
    'README.md',
    '.github/copilot-instructions.md',
  ]) {
    const actual = execFileSync('git', ['hash-object', `--path=${path}`, path], {
      cwd: upstream,
      encoding: 'utf8',
    }).trim();
    const original = execFileSync('git', ['rev-parse', `HEAD:${path}`], {
      cwd: upstream,
      encoding: 'utf8',
    }).trim();
    if (actual !== original) throw new Error(`Upstream integrity mismatch: ${path}`);
  }
  const overlay = readJson(resolve(root, 'product/devloom.json'));
  if (
    Object.keys(overlay).sort().join(',') !== 'nameLong,nameShort' ||
    overlay.nameShort !== 'Devloom IDE' ||
    overlay.nameLong !== 'Devloom IDE'
  )
    throw new Error('Invalid overlay');
  return {
    head,
    node: process.version,
    version: manifest.version,
    packageManager: manifest.packageManager,
    overlay,
    sourceDigest: createHash('sha256')
      .update(readFileSync(resolve(upstream, 'product.json')))
      .digest('hex'),
  };
}
export function prepare() {
  const result = check();
  writeFileSync(
    resolve(upstream, 'product.overrides.json'),
    `${JSON.stringify(result.overlay, null, 2)}\n`,
  );
  return result;
}
export function run(executable, args, cwd = root, env = process.env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolveRun() : reject(new Error(`Command failed: ${executable} (${code})`)),
    );
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepare();
  if (process.argv[2] === 'build') {
    await run('pnpm', ['run', 'compile-client'], upstream);
    if (!existsSync(resolve(upstream, 'out/vs/code/electron-main/main.js')))
      throw new Error('Missing compiled application');
  } else process.stdout.write(`${JSON.stringify(check())}\n`);
}
