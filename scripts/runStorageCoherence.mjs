import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, openSync, closeSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { root, upstream, check } from './upstream.mjs';
import { nativeRuntime } from './localExtensionInstall.mjs';
import { auditPatches } from './patchUpstream.mjs';
import { StorageSession, write, assertSecretFree } from './storageCoherenceSession.mjs';

function fileDigest(path) {
  const descriptor = openSync(path, 'r');
  const digest = createHash('sha256');
  const buffer = Buffer.alloc(65536);
  try {
    let count;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0)
      digest.update(buffer.subarray(0, count));
    return digest.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}
function binding() {
  const files = [
    'package.json',
    'upstream.lock.json',
    'patches/localGit/manifest.json',
    'patches/localGit/native-storage-coherence.patch',
    'patches/localGit/native-auth-storage.patch',
    'scripts/runStorageCoherence.mjs',
    'scripts/storageCoherenceSession.mjs',
    'tests/storageCoherenceCases.ts',
    'tests/storageCoherenceFixture.ts',
    'dist/tests/storageCoherenceCases.js',
    'dist/tests/storageCoherenceFixture.js',
    'vendor/code-oss/src/vs/base/parts/storage/common/storage.ts',
    'vendor/code-oss/src/vs/platform/storage/common/storageService.ts',
    'vendor/code-oss/src/vs/workbench/electron-browser/desktop.contribution.ts',
    'vendor/code-oss/out/vs/base/parts/storage/common/storage.js',
    'vendor/code-oss/out/vs/platform/storage/common/storageService.js',
    'vendor/code-oss/out/vs/workbench/electron-browser/desktop.contribution.js',
  ];
  return Object.fromEntries([
    ...files.map((path) => [path, fileDigest(join(root, path))]),
    ['sdk/node', fileDigest(process.execPath)],
    ['sdk/electron-executable', fileDigest(nativeRuntime(root).executable)],
    ['sdk/electron-types', fileDigest(join(upstream, '.build/typings/electron.d.ts'))],
  ]);
}

if (process.argv.length !== 2) throw new Error('NO_ARGUMENTS_SUPPORTED');
assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
assert.equal(process.version, 'v24.22.1');
auditPatches(root, upstream, false);
check();
const source = binding();
const session = new StorageSession(process.env.DEVLOOM_EVIDENCE_DIR);
const result = {
  status: 'fail',
  started: Date.now(),
  nonce: session.nonce,
  source,
  pins: JSON.parse(readFileSync(join(root, 'upstream.lock.json'), 'utf8')),
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  completed: [],
  observations: [],
};
const stage = async (profile, active, action, generation = 0, deleted = false) => {
  const observation = await session.stage(profile, active, action, generation, deleted);
  result.observations.push(observation);
  return observation;
};
try {
  const primary = await session.profile('shared', ['a', 'b']);
  let owner = session.launch(primary, 'a');
  let a = await session.activation(primary, 'a', owner);
  result.observations.push(a);
  const burst = await stage(primary, a, 'burst');
  assert.equal(burst.data.transitions, 12);
  assert.equal(burst.data.rotation, true);
  result.completed.push('native-own-12-rotation');
  const follower = session.launch(primary, 'b');
  const b = await session.activation(primary, 'b', owner);
  assert.equal(a.mainPid, b.mainPid);
  assert.notEqual(a.extensionHostPid, b.extensionHostPid);
  await stage(primary, b, 'arm', 14);
  await stage(primary, b, 'read');
  for (const deleted of [false, true]) {
    await stage(primary, a, 'arm', 15, deleted);
    await stage(primary, b, 'arm', 15, deleted);
    await stage(primary, b, 'write', 15, deleted);
    const foreign = await stage(primary, a, 'foreign');
    assert.equal(foreign.data.foreignObserved, true);
    await stage(primary, a, 'read');
    await stage(primary, b, 'read');
  }
  result.completed.push('native-two-window-foreign');
  const independent = await session.profile('independent', ['d']);
  const independentOwner = session.launch(independent, 'd');
  const d = await session.activation(independent, 'd', independentOwner);
  assert.notEqual(d.mainPid, a.mainPid);
  await stage(independent, d, 'arm', 0, true);
  await stage(independent, d, 'read');
  await stage(independent, d, 'write', 20);
  await stage(primary, a, 'read');
  result.completed.push('native-independent-root');
  await session.quit(independent, d, independentOwner);
  await session.closeWindow(primary, b, owner, follower);
  await stage(primary, a, 'write', 16);
  await session.quit(primary, a, owner);
  owner = session.launch(primary, 'a');
  a = await session.activation(primary, 'a', owner);
  await stage(primary, a, 'arm', 16);
  await stage(primary, a, 'read');
  await stage(primary, a, 'write', 16, true);
  await session.quit(primary, a, owner);
  owner = session.launch(primary, 'a');
  a = await session.activation(primary, 'a', owner);
  await stage(primary, a, 'arm', 16, true);
  await stage(primary, a, 'read');
  await session.quit(primary, a, owner);
  result.completed.push('native-clean-restart-value-delete');
  assert.deepEqual(binding(), source, 'SOURCE_CHANGED_DURING_RUN');
  result.status = 'pass';
} catch {
  result.failure = 'NATIVE_STORAGE_SUITE_FAILED';
} finally {
  try {
    result.privacy = assertSecretFree(
      [
        session.evidence,
        session.temporary,
        ...session.profiles.map((profile) => profile.artifact.stage),
      ],
      session.nonce,
    );
  } catch {
    result.privacy = { secretFree: false };
    result.status = 'fail';
  }

  try {
    result.cleanup = await session.cleanup();
  } catch {
    result.cleanup = { forced: true, leftovers: [session.temporary] };
  }
  if (result.cleanup.forced || result.cleanup.leftovers.length) result.status = 'fail';
  try {
    assertSecretFree([session.evidence], session.nonce);
  } catch {
    result.privacy = { secretFree: false };
    result.status = 'fail';
  }
  result.finished = Date.now();
  write(join(session.evidence, 'run-result.json'), result);
}
process.stdout.write(
  `Storage coherence ${result.status}: ${join(session.evidence, 'run-result.json')}\n`,
);
if (result.status !== 'pass') process.exitCode = 1;
