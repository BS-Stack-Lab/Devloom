import * as fs from 'node:fs';
import { resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { digest, within, limits } from './componentInventoryFiles.mjs';
export const identities = [
  'product.json',
  'LICENSE.txt',
  'README.md',
  '.github/copilot-instructions.md',
];
export const gitEnvironment = Object.freeze({
  PATH: '/usr/bin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
  HOME: '/dev/null',
  XDG_CONFIG_HOME: '/dev/null',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
});
export const gitPrefix = [
  '--no-pager',
  '--no-optional-locks',
  '--no-lazy-fetch',
  '--no-replace-objects',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'credential.helper=',
  '-c',
  'core.askPass=',
  '-c',
  'core.pager=cat',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'core.excludesFile=/dev/null',
  '-c',
  'submodule.recurse=false',
];
const fail = (code) => {
  throw new Error(code);
};
export function compareIdentity(original, actual) {
  if (original.equals(actual)) return 'exact';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    decoder.decode(original);
    decoder.decode(actual);
  } catch {
    fail('source-integrity');
  }
  if (original.includes(0) || original.includes(13) || actual.includes(0)) fail('source-integrity');
  for (let index = 0; index < actual.length; index++)
    if (actual[index] === 13 && actual[index + 1] !== 10) fail('source-integrity');
  if (!Buffer.from(actual.toString('utf8').replaceAll('\r\n', '\n')).equals(original))
    fail('source-integrity');
  return 'builtin-crlf-to-lf';
}
export function validateConfig(bytes) {
  if (bytes.length > 1048576 || bytes.includes(0)) fail('config-policy');
  let section,
    bare = false,
    format = false;
  for (const line of bytes.toString('utf8').split(/\r?\n/)) {
    const text = line.trim();
    if (!text || /^[#;]/.test(text)) continue;
    const header = /^\[([a-zA-Z]+)(?: "([a-zA-Z0-9_.-]+)")?\]$/.exec(text);
    if (header) {
      section = header[1].toLowerCase();
      if ((section === 'remote') !== !!header[2]) fail('config-policy');
      continue;
    }
    const entry = /^([a-zA-Z][a-zA-Z0-9]*)\s*=\s*([^\\\r\n]*)$/.exec(text);
    if (!entry || !section) fail('config-policy');
    const key = `${section}.${entry[1].toLowerCase()}`,
      value = entry[2].trim();
    const allowed = [
      'core.repositoryformatversion',
      'core.bare',
      'core.filemode',
      'core.ignorecase',
      'core.logallrefupdates',
      'core.precomposeunicode',
      'remote.url',
      'remote.fetch',
      'lfs.repositoryformatversion',
      'pull.rebase',
      'blame.ignorerevsfile',
    ];
    if (!allowed.includes(key)) fail('config-policy');
    if (key === 'core.bare') {
      if (value !== 'false') fail('config-policy');
      bare = true;
    }
    if (key === 'core.repositoryformatversion') {
      if (value !== '0') fail('config-policy');
      format = true;
    }
  }
  if (!bare || !format) fail('config-policy');
}
function regular(path, max) {
  const stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) fail('metadata-policy');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > max) fail('metadata-policy');
    const chunks = [],
      chunk = Buffer.alloc(262144);
    let total = 0,
      size;
    while ((size = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      total += size;
      if (total > max) fail('metadata-policy');
      chunks.push(Buffer.from(chunk.subarray(0, size)));
    }
    const after = fs.fstatSync(fd);
    if (
      total !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      fail('metadata-policy');
    return Buffer.concat(chunks);
  } finally {
    fs.closeSync(fd);
  }
}
function metadata(upstream) {
  const git = resolve(upstream, '.git');
  const stat = fs.lstatSync(git);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('metadata-policy');
  let count = 0;
  function inspect(path, depth = 0) {
    if (depth > limits.depth || ++count > limits.entries) fail('metadata-policy');
    const current = fs.lstatSync(path);
    if (current.isSymbolicLink()) fail('metadata-policy');
    if (current.isDirectory())
      for (const name of fs.readdirSync(path)) inspect(resolve(path, name), depth + 1);
    else if (!current.isFile()) fail('metadata-policy');
    else if (
      relative(git, path) === 'index'
        ? current.size > 268435456
        : !relative(git, path).startsWith('objects/') && current.size > 16777216
    )
      fail('metadata-policy');
  }
  inspect(git);
  for (const name of ['commondir', 'gitdir', 'config.worktree'])
    if (fs.existsSync(resolve(git, name))) fail('metadata-policy');
  const alternates = resolve(git, 'objects/info/alternates');
  if (fs.existsSync(alternates) && regular(alternates, 1048576).length) fail('metadata-policy');
  validateConfig(regular(resolve(git, 'config'), 1048576));
}
export function strictGit(
  root,
  upstream,
  { executable = '/opt/homebrew/bin/git', spawn = execFileSync } = {},
) {
  metadata(upstream);
  const manifest = JSON.parse(
    regular(resolve(root, 'patches/localGit/manifest.json'), limits.json),
  );
  if (
    !/^[a-f0-9]{40}$/.test(manifest.commit) ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    !Array.isArray(manifest.patches)
  )
    fail('patch-policy');
  const valid = (base, name) => {
    if (
      typeof name !== 'string' ||
      !/^[a-zA-Z0-9_.\-/]+$/.test(name) ||
      name.split('/').some((part) => !part || part === '..' || part.startsWith('-'))
    )
      fail('patch-policy');
    const path = resolve(base, name);
    if (!within(base, path)) fail('patch-policy');
    let cursor = base;
    for (const part of name.split('/')) {
      cursor = resolve(cursor, part);
      if (fs.lstatSync(cursor).isSymbolicLink()) fail('patch-policy');
    }
    if (!within(base, fs.realpathSync(path))) fail('patch-policy');
    regular(path, limits.license);
  };
  for (const file of manifest.files) {
    valid(upstream, file.path);
    if (![file.before, file.after].every((value) => /^[a-f0-9]{64}$/.test(value)))
      fail('patch-policy');
  }
  for (const patch of manifest.patches) {
    if (!patch.path?.startsWith('patches/localGit/')) fail('patch-policy');
    valid(resolve(root, 'patches/localGit'), patch.path.slice(17));
    if (!/^[a-f0-9]{64}$/.test(patch.sha256)) fail('patch-policy');
  }
  for (const path of identities) valid(upstream, path);
  const options = {
    cwd: upstream,
    env: { ...gitEnvironment },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: limits.timeout,
    maxBuffer: limits.stdout,
  };
  const invoke = (args) => {
    try {
      return Buffer.from(spawn(executable, args, options));
    } catch {
      fail('git-provenance-failed');
    }
  };
  if (invoke(['--version']).toString().trim() !== 'git version 2.53.0') fail('unsupported-git');
  const allowed = new Set(
    [
      ['rev-parse', 'HEAD'],
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--ignore-submodules=all',
        '--name-only',
        '-z',
        'HEAD',
        '--',
      ],
      ['ls-files', '--others', '--exclude-standard', '-z', '--'],
      ...[...manifest.files.map((file) => file.path), ...identities].map((path) => [
        'show',
        `${manifest.commit}:${path}`,
      ]),
      ...identities.flatMap((path) => [
        ['hash-object', '--no-filters', '--', path],
        ['rev-parse', `HEAD:${path}`],
      ]),
    ].map((args) => JSON.stringify(args)),
  );
  const runner = (args) => {
    if (!allowed.has(JSON.stringify(args))) fail('unsupported-git-argv');
    return invoke([...gitPrefix, ...args]);
  };
  runner.identity = [];
  runner.verifyIdentity = (path) => {
    const original = runner(['show', `${manifest.commit}:${path}`]);
    const actual = regular(resolve(upstream, path), limits.json);
    const comparisonMode = compareIdentity(original, actual);
    runner.identity.push({
      path,
      comparisonMode,
      worktreeSha256: digest(actual),
      sourceOriginalSha256: digest(original),
      rawWorktreeBlobOid: runner(['hash-object', '--no-filters', '--', path]).toString().trim(),
      originalBlobOid: runner(['rev-parse', `HEAD:${path}`])
        .toString()
        .trim(),
    });
  };
  return runner;
}
