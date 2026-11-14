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
