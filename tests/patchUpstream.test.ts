import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
test('exact patch audit is idempotent and rejects source, manifest and unknown-file drift', () => {
  const root = mkdtempSync(join(tmpdir(), 'devloom-patch-'));
  const upstream = join(root, 'upstream');
  const patches = join(root, 'patches/localGit');
  mkdirSync(upstream);
  mkdirSync(patches, { recursive: true });
  const git = (args: string[]) => execFileSync('git', args, { cwd: upstream, stdio: 'pipe' });
  const audit = () =>
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { auditPatches } from ${JSON.stringify(pathToFileURL(resolve('scripts/patchUpstream.mjs')).href)}; auditPatches(${JSON.stringify(root)}, ${JSON.stringify(upstream)}, true);`,
      ],
      { stdio: 'pipe' },
    );
  try {
    git(['init']);
    git(['config', 'user.name', 'Fixture']);
    git(['config', 'user.email', 'fixture@invalid.local']);
    writeFileSync(join(upstream, 'source.ts'), 'before\n');
    writeFileSync(join(upstream, 'other.ts'), 'untouched\n');
    git(['add', '.']);
    git(['commit', '-m', 'fixture']);
    const commit = git(['rev-parse', 'HEAD']).toString().trim();
    writeFileSync(join(upstream, 'source.ts'), 'after\n');
    const patch = git(['diff', '--', 'source.ts']);
    writeFileSync(join(patches, 'native.patch'), patch);
    writeFileSync(join(upstream, 'source.ts'), 'before\n');
    const manifest = {
      commit,
      patches: [{ path: 'patches/localGit/native.patch', sha256: hash(patch) }],
      files: [{ path: 'source.ts', before: hash('before\n'), after: hash('after\n') }],
    };
    const manifestPath = join(patches, 'manifest.json');
    const save = () => writeFileSync(manifestPath, JSON.stringify(manifest));
    save();
    audit();
    const first = readFileSync(join(upstream, 'source.ts'));
    audit();
    assert.deepEqual(readFileSync(join(upstream, 'source.ts')), first);
    writeFileSync(join(upstream, 'source.ts'), 'drift\n');
    assert.throws(audit, /Command failed/);
    writeFileSync(join(upstream, 'source.ts'), 'after\n');
    writeFileSync(join(upstream, 'other.ts'), 'unknown change\n');
    assert.throws(audit, /Command failed/);
    writeFileSync(join(upstream, 'other.ts'), 'untouched\n');
    manifest.files[0].before = hash('wrong\n');
    save();
    assert.throws(audit, /Command failed/);
    manifest.files[0].before = hash('before\n');
    manifest.commit = '0'.repeat(40);
    save();
    assert.throws(audit, /Command failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registered four same-pin payloads apply pristine and reject mixed state, tamper and unrelated drift', () => {
  const repository = resolve('.');
  const vendor = resolve('vendor/code-oss');
  const manifest = JSON.parse(readFileSync(resolve('patches/localGit/manifest.json'), 'utf8')) as {
    version: number;
    commit: string;
    patches: { path: string; sha256: string }[];
    files: { path: string; before: string; after: string }[];
  };
  assert.equal(manifest.commit, '69047191fc427f2f92828279aae1d90d8eeda7ab');
  assert.equal(manifest.patches.length, 4);
  assert.equal(
    manifest.patches[3].sha256,
    '917ea4121e896b2d93e4bd82cc9eccd48c7f0f5d81b2afb7d626a3108cbe3578',
  );
  assert.deepEqual(manifest.patches.slice(0, 2), [
    {
      path: 'patches/localGit/main-broker.patch',
      sha256: '90a13d73a205fb767afe26fe037bbbd7a699afbe35bd15769bf6328269bef07b',
    },
    {
      path: 'patches/localGit/native-git.patch',
      sha256: '14ec7c0f54d477aa7e22672168c34abc4426a5865ccc5f194b07f4e6f838e3a3',
    },
  ]);
  assert.deepEqual(
    manifest.files.slice(8).map((file) => file.path),
    [
      'src/vs/base/parts/storage/common/storage.ts',
      'src/vs/platform/storage/common/storageService.ts',
      'src/vs/workbench/electron-browser/desktop.contribution.ts',
    ],
  );
  const temporary = mkdtempSync(join(tmpdir(), 'devloom-storage-patches-'));
  const upstream = join(temporary, 'upstream');
  mkdirSync(upstream);
  mkdirSync(join(temporary, 'patches/localGit'), { recursive: true });
  const git = (args: string[]) => execFileSync('git', args, { cwd: upstream, stdio: 'pipe' });
  const source = new Map<string, Buffer>();
  const audit = () =>
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { auditPatches } from ${JSON.stringify(pathToFileURL(resolve('scripts/patchUpstream.mjs')).href)}; auditPatches(${JSON.stringify(temporary)}, ${JSON.stringify(upstream)}, true);`,
      ],
      { stdio: 'pipe' },
    );
  try {
    git(['init']);
    git(['config', 'user.name', 'Fixture']);
    git(['config', 'user.email', 'fixture@invalid.local']);
    for (const file of manifest.files) {
      const bytes: Buffer = execFileSync('git', ['show', `${manifest.commit}:${file.path}`], {
        cwd: vendor,
      });
      assert.equal(hash(bytes), file.before);
      source.set(file.path, bytes);
      const target = join(upstream, file.path);
      mkdirSync(resolve(target, '..'), { recursive: true });
      writeFileSync(target, bytes);
    }
    writeFileSync(join(upstream, 'unrelated.ts'), 'preserved\n');
    git(['add', '.']);
    git(['commit', '-m', 'fixture']);
    for (const patch of manifest.patches) {
      const bytes = readFileSync(join(repository, patch.path));
      assert.equal(hash(bytes), patch.sha256);
      writeFileSync(join(temporary, patch.path), bytes);
    }
    const fixtureManifest = { ...manifest, commit: git(['rev-parse', 'HEAD']).toString().trim() };
    writeFileSync(
      join(temporary, 'patches/localGit/manifest.json'),
      JSON.stringify(fixtureManifest),
    );
    audit();
    audit();
    for (const file of manifest.files)
      assert.equal(hash(readFileSync(join(upstream, file.path))), file.after);
    const file = manifest.files[8];
    writeFileSync(join(upstream, file.path), source.get(file.path)!);
    assert.throws(audit);
    for (const entry of manifest.files)
      writeFileSync(join(upstream, entry.path), source.get(entry.path)!);
    audit();
    writeFileSync(join(upstream, 'unrelated.ts'), 'drift\n');
    assert.throws(audit);
    writeFileSync(join(upstream, 'unrelated.ts'), 'preserved\n');
    writeFileSync(join(upstream, file.path), 'unrecognized source\n');
    assert.throws(audit);
    for (const entry of manifest.files)
      writeFileSync(join(upstream, entry.path), source.get(entry.path)!);
    audit();
    const patch = manifest.patches[2];
    writeFileSync(join(temporary, patch.path), 'tampered\n');
    assert.throws(audit);
    writeFileSync(join(temporary, patch.path), readFileSync(join(repository, patch.path)));
    fixtureManifest.files[8].after = '0'.repeat(64);
    writeFileSync(
      join(temporary, 'patches/localGit/manifest.json'),
      JSON.stringify(fixtureManifest),
    );
    assert.throws(audit);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
