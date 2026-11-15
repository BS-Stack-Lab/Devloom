import assert from 'node:assert/strict';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash } from './localExtensionArtifact.mjs';

export function sourceEvidence(root) {
  const paths = [
    'scripts/devloom.mjs',
    'scripts/developmentProfile.mjs',
    'scripts/localExtensionArtifact.mjs',
    'scripts/localExtensionInstall.mjs',
    'extensions/devloom-bootstrap/src/extension.ts',
    'extensions/devloom-bootstrap/src/appRoot.ts',
    'scripts/runNormalInstallation.mjs',
    'tests/localExtensionInstall.test.mjs',
    'tests/appRoot.test.ts',
    'scripts/runDevelopmentProfiles.mjs',
    'tests/developmentProfile.test.mjs',
    'tests/developmentProfileHost.ts',
    'scripts/runCommitState.mjs',
    'scripts/commitStateSession.mjs',
    'scripts/commitStateEvidence.mjs',
    'scripts/commitStateFixture.mjs',
    'scripts/commitStateUI.mjs',
    'tests/commitStateFixtures.ts',
    'tests/commitStateGit.ts',
    'tests/commitStateHost.ts',
    'tests/commitStateScenarios.ts',
    'tests/commitStateRunner.test.mjs',
    'package.json',
    'README.md',
  ];
  return Object.fromEntries(paths.map((path) => [path, hash(readFileSync(join(root, path)))]));
}
export function backupEvidence(profile, evidence, label, binding) {
  const directory = join(profile.userData, 'Backups');
  const files = {};
  if (existsSync(directory)) {
    const names = readdirSync(directory, { recursive: true });
    assert.ok(names.length < 200);
    for (const name of names) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      assert.ok(!stat.isSymbolicLink());
      if (stat.isFile()) {
        assert.ok(stat.size < 2 * 1024 * 1024);
        files[name] = { bytes: readFileSync(path).toString('base64'), mode: stat.mode & 0o777 };
      }
    }
  }
  writeFileSync(
    join(evidence, `${label}-backups.json`),
    JSON.stringify({ ...binding, observed: Date.now(), files }),
    { flag: 'wx', mode: 0o600 },
  );
  return files;
}
