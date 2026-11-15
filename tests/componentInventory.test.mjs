import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createFiles, digest } from '../scripts/componentInventoryFiles.mjs';
import { collectPackages, collectExtensions } from '../scripts/componentInventoryCollectors.mjs';
import {
  compareIdentity,
  strictGit,
  validateConfig,
  gitEnvironment,
  gitPrefix,
} from '../scripts/componentInventoryGit.mjs';
import { auditPatches } from '../scripts/patchUpstream.mjs';
import { rustProvenance, electronProvenance } from '../scripts/componentInventoryProvenance.mjs';
const put = (root, path, bytes) => {
  fs.mkdirSync(resolve(root, path, '..'), { recursive: true });
  fs.writeFileSync(resolve(root, path), bytes);
};
const fixture = (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(resolve(tmpdir(), 'inventory-components-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
const pkg = (root, path, name, version = '1.0') => {
  put(root, `${path}/package.json`, JSON.stringify({ name, version, license: 'MIT' }));
  put(root, `${path}/LICENSE`, 'MIT');
};
test('hoisted scoped nested isolated packages deduplicate aliases and attribute native bytes', (t) => {
  const root = fixture(t);
  pkg(root, 'node_modules/a', 'a');
  pkg(root, 'node_modules/@scope/b', '@scope/b');
  pkg(root, 'node_modules/a/node_modules/b', 'b', '2');
  pkg(root, 'node_modules/.pnpm/c@1/node_modules/c', 'c');
  put(root, 'node_modules/a/data/package.json', '{}');
  put(root, 'node_modules/a/addon.node', 'malformed-native');
  fs.symlinkSync('.pnpm/c@1/node_modules/c', resolve(root, 'node_modules/c'));
  const files = createFiles(root),
    result = collectPackages(files, [resolve(root, 'node_modules')]);
  assert.equal(result.packages.length, 4);
  assert.equal(result.nativeArtifacts.length, 1);
  assert.equal(result.nativeArtifacts[0].sha256, digest('malformed-native'));
  assert.match(result.nativeArtifacts[0].owner, /:a:1.0$/);
  assert.equal(result.nativeArtifacts[0].type, 'unknown');
  assert.deepEqual(files.diagnostics, []);
});
test('source and downloaded extensions distinguish archive and manifest hashes', (t) => {
  const root = fixture(t);
  pkg(root, 'extensions/a', 'a');
  pkg(root, '.build/builtInExtensions/a', 'a');
  const files = createFiles(root),
    result = collectExtensions(files, root, {
      builtInExtensions: [{ name: 'a', sha256: 'a'.repeat(64), repo: 'https://example.com/a' }],
    });
  assert.equal(result.extensions.length, 2);
  assert.deepEqual(
    result.extensions.map((item) => item.kind),
    ['source', 'downloaded'],
  );
  assert.equal(result.extensions[0].declaredArchiveSha256, 'a'.repeat(64));
  assert.notEqual(result.extensions[0].manifestSha256, 'a'.repeat(64));
});
test('fixed identity accepts only exact or CRLF text and preserves raw hash distinction', () => {
  const original = Buffer.from('hello\nworld\n'),
    actual = Buffer.from('hello\r\nworld\r\n');
  assert.equal(compareIdentity(original, original), 'exact');
  assert.equal(compareIdentity(original, actual), 'builtin-crlf-to-lf');
  assert.notEqual(digest(original), digest(actual));
  for (const bytes of [
    Buffer.from('hello\rworld\n'),
    Buffer.from('hello\nworld!\n'),
    Buffer.from([0xff]),
    Buffer.from('hello\0\r\n'),
  ])
    assert.throws(() => compareIdentity(original, bytes));
});
function gitFixture(t) {
  const root = fixture(t),
    upstream = resolve(root, 'source');
  fs.mkdirSync(upstream);
  const git = (args) =>
    execFileSync('/opt/homebrew/bin/git', args, {
      cwd: upstream,
      env: { ...gitEnvironment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git(['init', '-q']);
  fs.mkdirSync(resolve(root, 'empty-hooks'));
  git(['config', '--local', 'core.hooksPath', resolve(root, 'empty-hooks')]);
  for (const path of [
    'product.json',
    'LICENSE.txt',
    'README.md',
    '.github/copilot-instructions.md',
  ])
    put(upstream, path, 'identity\n');
  put(upstream, 'source.txt', 'before');
  put(upstream, 'second.txt', 'before2');
  put(upstream, '.gitattributes', '* filter=evil diff=evil\n');
  git(['add', '.']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  git(['config', '--local', '--unset', 'core.hooksPath']);
  const commit = git(['rev-parse', 'HEAD']).toString().trim();
  put(root, 'patches/localGit/payload.patch', 'payload');
  const manifest = {
    commit,
    patches: [{ path: 'patches/localGit/payload.patch', sha256: digest('payload') }],
    files: [
      { path: 'source.txt', before: digest('before'), after: digest('after') },
      { path: 'second.txt', before: digest('before2'), after: digest('after2') },
    ],
  };
  put(root, 'patches/localGit/manifest.json', JSON.stringify(manifest));
  put(upstream, 'source.txt', 'after');
  put(upstream, 'second.txt', 'after2');
  return { root, upstream, git, manifest };
}
test('strict Git validates provenance, refuses writes and preserves source/index/config', (t) => {
  const { root, upstream } = gitFixture(t);
  const snapshots = ['source.txt', '.git/index', '.git/config'].map((path) =>
    fs.readFileSync(resolve(upstream, path)),
  );
  const calls = [],
    runner = strictGit(root, upstream, {
      spawn: (exe, args, options) => {
        calls.push({ args, env: options.env });
        return execFileSync(exe, args, options);
      },
    });
  assert.equal(auditPatches(root, upstream, false, { runGit: runner }).state, 'verified');
  runner.verifyIdentity('LICENSE.txt');
  assert.equal(runner.identity[0].comparisonMode, 'exact');
  put(upstream, 'LICENSE.txt', 'identity\r\n');
  runner.verifyIdentity('LICENSE.txt');
  assert.equal(runner.identity[1].comparisonMode, 'builtin-crlf-to-lf');
  assert.throws(() => runner(['apply', '--check', 'anything']), /unsupported-git-argv/);
  assert.throws(() => runner(['config', '--list']), /unsupported-git-argv/);
  assert.deepEqual(calls[1].args.slice(0, gitPrefix.length), gitPrefix);
  assert.deepEqual(calls[0].env, gitEnvironment);
  assert(!Object.hasOwn(calls[0].env, 'NODE_OPTIONS'));
  for (const [index, path] of ['source.txt', '.git/index', '.git/config'].entries())
    assert.deepEqual(fs.readFileSync(resolve(upstream, path)), snapshots[index]);
});
test('read-only patch audit refuses pristine partial and drift without applying', (t) => {
  const { root, upstream, manifest } = gitFixture(t);
  const runner = strictGit(root, upstream);
  put(upstream, 'source.txt', 'before');
  assert.throws(() => auditPatches(root, upstream, false, { runGit: runner }), /Partially applied/);
  put(upstream, 'second.txt', 'before2');
  assert.throws(() => auditPatches(root, upstream, false, { runGit: runner }), /not applied/);
  assert.equal(fs.readFileSync(resolve(upstream, 'source.txt'), 'utf8'), 'before');
  assert.throws(
    () => auditPatches(root, upstream, true, { runGit: runner }),
    /unsupported-git-argv/,
  );
  assert.equal(fs.readFileSync(resolve(upstream, 'source.txt'), 'utf8'), 'before');
  put(upstream, 'source.txt', 'drift');
  assert.throws(() => auditPatches(root, upstream, false, { runGit: runner }), /drift/);
  manifest.commit = '0'.repeat(40);
  put(root, 'patches/localGit/manifest.json', JSON.stringify(manifest));
  assert.throws(() => auditPatches(root, upstream, false, { runGit: runner }), /pin mismatch/);
});
test('config includes helpers unknown keys and symlink metadata are refused before Git spawn', (t) => {
  const { root, upstream } = gitFixture(t),
    config = resolve(upstream, '.git/config'),
    original = fs.readFileSync(config);
  for (const entry of [
    '[include]\n path = /secret',
    '[core]\n fsmonitor = helper',
    '[filter "evil"]\n process = helper',
    '[extensions]\n objectFormat = sha256',
    '[core]\n unknown = secret',
  ]) {
    fs.writeFileSync(config, Buffer.concat([original, Buffer.from(`\n${entry}\n`)]));
    assert.throws(
      () => strictGit(root, upstream, { spawn: () => assert.fail('spawned unsafe config') }),
      /config-policy/,
    );
  }
  fs.writeFileSync(config, original);
  fs.symlinkSync('/private/tmp', resolve(upstream, '.git/evil'));
  assert.throws(() => strictGit(root, upstream, { spawn: () => assert.fail() }), /metadata-policy/);
  assert.throws(
    () => validateConfig(Buffer.from('[core]\n bare=true\n repositoryformatversion=0')),
    /config-policy/,
  );
});
test('patch traversal and metadata alternates fail before subprocess', (t) => {
  const { root, upstream, manifest } = gitFixture(t);
  manifest.files[0].path = '../secret';
  put(root, 'patches/localGit/manifest.json', JSON.stringify(manifest));
  assert.throws(() => strictGit(root, upstream, { spawn: () => assert.fail() }), /patch-policy/);
  put(upstream, '.git/objects/info/alternates', '/secret\n');
  assert.throws(() => strictGit(root, upstream), /metadata-policy/);
});
test('Cargo offline failure and missing Electron remain unknown without executing packages', (t) => {
  const root = fixture(t);
  put(root, 'crates/devloom-sidecar/Cargo.toml', 'manifest');
  put(root, 'crates/devloom-sidecar/Cargo.lock', 'lock');
  const files = createFiles(root);
  let called = false;
  const rust = rustProvenance(files, {
    spawn: (executable, args, options) => {
      called = true;
      assert(args.includes('--offline'));
      assert(args.includes('--locked'));
      assert.equal(options.shell, false);
      assert.equal(options.env.CARGO_NET_OFFLINE, 'true');
      throw new Error('secret raw stderr');
    },
  });
  assert(called);
  assert.equal(rust.buildProvenance, 'unknown');
  assert.equal(rust.lockSha256, digest('lock'));
  const electron = electronProvenance(files, root, '43.8.6');
  assert.equal(electron.runtimeLoaded, 'unknown');
  assert(files.diagnostics.length);
  assert(!JSON.stringify(files.diagnostics).includes('secret'));
});
