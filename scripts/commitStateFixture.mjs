import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildLocalArtifact } from './localExtensionArtifact.mjs';
import { ensureLocalExtension } from './localExtensionInstall.mjs';

export async function installCompanion(root, profile, fixture, env) {
  assert.equal(profile.created, true, 'Fixture settings are fresh-profile only');
  const artifact = buildLocalArtifact(root, {
    manifest: {
      name: 'commit-state-fixture',
      publisher: 'devloom',
      version: '1.0.0',
      engines: { vscode: '^1.146.0' },
      main: './commitStateHost.js',
      activationEvents: ['onStartupFinished'],
    },
    files: Object.fromEntries(
      ['Host', 'Scenarios', 'Fixtures', 'Git'].map((name) => [
        `commitState${name}.js`,
        join(root, `dist/tests/commitState${name}.js`),
      ]),
    ),
    data: { 'fixture.json': fixture },
  });
  const settings = JSON.parse(readFileSync(profile.settings, 'utf8'));
  writeFileSync(
    profile.settings,
    JSON.stringify(
      {
        ...settings,
        'window.title': `commit-state ${fixture.nonce}`,
        'window.dialogStyle': 'custom',
        'files.autoSave': 'off',
        'files.hotExit': 'onExitAndWindowClose',
        'window.restoreWindows': 'all',
        'workbench.editor.restoreViewState': true,
        'security.workspace.trust.enabled': false,
        'workbench.startupEditor': 'none',
        'git.path': fixture.gitPath,
        'git.autoRepositoryDetection': false,
        'git.openRepositoryInParentFolders': 'never',
        'git.promptToSaveFilesBeforeCommit': 'always',
        'git.useEditorAsCommitInput': false,
        'git.confirmSync': false,
        'git.autofetch': 'off',
        'git.postCommitCommand': 'none',
        'git.showActionButton': { commit: true, publish: false, sync: false },
      },
      null,
      2,
    ),
  );
  return ensureLocalExtension(root, profile, artifact, { env });
}
