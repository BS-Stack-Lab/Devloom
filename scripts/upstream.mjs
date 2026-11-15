import { auditPatches } from './patchUpstream.mjs';
import { execFileSync, spawn } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  lstatSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  constants,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
export const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const upstream = resolve(root, 'vendor/code-oss');
const PIN = '69047191fc427f2f92828279aae1d90d8eeda7ab';
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
export function check(options = {}) {
  const git = options.runGit ?? ((args) => execFileSync('git', args, { cwd: upstream }));
  auditPatches(root, upstream, !options.readOnly, options);
  const lock = readJson(resolve(root, 'upstream.lock.json'));
  const head = git(['rev-parse', 'HEAD']).toString().trim();
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
    if (options.readOnly) {
      options.runGit.verifyIdentity(path);
      continue;
    }
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
    Object.keys(overlay).sort().join(',') !== 'applicationName,dataFolderName,nameLong,nameShort' ||
    overlay.nameShort !== 'Devloom IDE' ||
    overlay.nameLong !== 'Devloom IDE' ||
    overlay.applicationName !== 'devloom' ||
    overlay.dataFolderName !== '.devloom'
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
function regularOverlay(path, directory = false) {
  try {
    const value = lstatSync(path);
    if (value.isSymbolicLink() || (directory ? !value.isDirectory() : !value.isFile()))
      throw new Error('Unsafe generated overlay path');
    return true;
  } catch (error) {
    if (!directory && error.code === 'ENOENT') return false;
    throw error;
  }
}
export function publishOverlay(directory, overlay) {
  const target = resolve(directory, 'product.overrides.json');
  const staging = resolve(directory, '.build');
  regularOverlay(staging, true);
  const bytes = `${JSON.stringify(overlay, null, 2)}\n`;
  if (regularOverlay(target) && readFileSync(target, 'utf8') === bytes) return;
  const temporary = resolve(staging, `devloom-overlay-${randomUUID()}.json`);
  let descriptor;
  let owned = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    owned = true;
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    regularOverlay(staging, true);
    regularOverlay(target);
    renameSync(temporary, target);
    owned = false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (owned) unlinkSync(temporary);
  }
}
export function prepare() {
  const result = check();
  publishOverlay(upstream, result.overlay);
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
