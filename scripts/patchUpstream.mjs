import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
export function auditPatches(root, upstream, apply = false) {
  const manifest = JSON.parse(
    readFileSync(resolve(root, 'patches/localGit/manifest.json'), 'utf8'),
  );
  const git = (args) => execFileSync('git', args, { cwd: upstream });
  if (git(['rev-parse', 'HEAD']).toString().trim() !== manifest.commit)
    throw new Error('Patch upstream pin mismatch');
  const paths = new Set(manifest.files.map((file) => file.path));
  const changed = git(['diff', '--name-only', '-z', 'HEAD']).toString().split('\0').filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'])
    .toString()
    .split('\0')
    .filter(Boolean);
  if (untracked.length) throw new Error('Unknown untracked upstream source modification');
  if (changed.some((path) => !paths.has(path)))
    throw new Error('Unknown upstream source modification');
  for (const patch of manifest.patches) {
    const payload = readFileSync(resolve(root, patch.path));
    if (hash(payload) !== patch.sha256) throw new Error('Patch payload digest mismatch');
  }
  const states = manifest.files.map((file) => {
    if (hash(git(['show', `${manifest.commit}:${file.path}`])) !== file.before)
      throw new Error('Patch preimage mismatch');
    const actual = hash(readFileSync(resolve(upstream, file.path)));
    if (actual !== file.before && actual !== file.after) throw new Error('Patch source drift');
    return actual === file.after ? 'after' : 'before';
  });
  if (states.some((state) => state !== states[0])) throw new Error('Partially applied patches');
  if (states[0] === 'before' && apply) {
    for (const patch of manifest.patches) git(['apply', '--check', resolve(root, patch.path)]);
    for (const patch of manifest.patches) git(['apply', resolve(root, patch.path)]);
  } else if (states[0] === 'before') throw new Error('Product patches are not applied');
  for (const file of manifest.files)
    if (hash(readFileSync(resolve(upstream, file.path))) !== file.after)
      throw new Error('Patch postimage mismatch');
  return { commit: manifest.commit, files: manifest.files.length, state: 'verified' };
}
