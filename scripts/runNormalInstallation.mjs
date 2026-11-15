import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { Session, write } from './commitStateSession.mjs';
import { CDP, ownedTarget, waitFor, delay } from './commitStateUI.mjs';
import {
  buildLocalArtifact,
  bootstrapPayload,
  verifyInstalled,
} from './localExtensionArtifact.mjs';
import {
  ensureLocalExtension,
  nativeCLI,
  nativeRuntime,
  localEnvironment,
} from './localExtensionInstall.mjs';
import { developmentProfile } from './developmentProfile.mjs';
import { root } from './upstream.mjs';

let session = new Session(process.env.DEVLOOM_EVIDENCE_DIR);
const evidence = session.evidence;
const sessions = [session];
const result = {
  status: 'fail',
  nonce: session.nonce,
  session: session.id,
  completed: [],
  observations: [],
};
const profiles = [];
let ui;
let modes = [];
let foreign;
let contacts = 0;
const stage = async (action) => {
  const observation = await session.stage('restart', action);
  result.observations.push(observation);
  return observation.data;
};
async function palette(text) {
  await ui.key('F1', 'F1', 0, 112);
  await waitFor('command palette', () =>
    ui.evaluate(`!!document.querySelector('.quick-input-widget input')`),
  );
  await ui.call('Input.insertText', { text: `>${text}` });
  await waitFor('command palette match', () =>
    ui.evaluate(
      `document.querySelector('.quick-input-list')?.innerText.includes(${JSON.stringify(text)})`,
    ),
  );
  await ui.screenshot(join(session.evidence, `palette-${Date.now()}.png`));
  await ui.key('Enter', 'Enter', 0, 13);
}
try {
  const originalCwd = process.cwd();
  const third = join(session.temporary, 'third-unrelated');
  mkdirSync(third, { mode: 0o700 });
  const socket = join(session.temporary, 'foreign.sock');
  foreign = createServer((connection) => {
    contacts++;
    connection.destroy();
  });
  await new Promise((done, reject) => {
    foreign.once('error', reject);
    foreign.listen(socket, done);
  });
  const inherited = {
    ...session.env,
    VSCODE_IPC_HOOK_CLI: socket,
    VSCODE_CLIENT_COMMAND: 'foreign',
    VSCODE_CLIENT_COMMAND_CWD: third,
    VSCODE_CLI_AUTHORITY: 'foreign',
    VSCODE_PORTABLE: third,
    VSCODE_APPDATA: third,
    VSCODE_CWD: third,
    VSCODE_IPC_HOOK: socket,
    VSCODE_PID: '2',
    ELECTRON_RUN_AS_NODE: 'foreign',
  };
  try {
    for (const [index, caller] of [session.workspace, third].entries()) {
      process.chdir(caller);
      const profile = developmentProfile(root, `qa-${session.nonce.slice(0, 12)}-cli${index}`);
      profiles.push(profile);
      const artifact = buildLocalArtifact(root);
      const install = await ensureLocalExtension(root, profile, artifact, { env: inherited });
      assert.equal(install.status, 'installed');
      for (const call of install.calls) {
        assert.equal(call.cwd, realpathSync(join(root, 'vendor/code-oss')));
        assert.equal(call.observedCwd, call.cwd);
        assert.notEqual(call.cwd, caller);
      }
      write(join(session.evidence, `actual-caller-${index}.json`), {
        caller: process.cwd(),
        source: root,
        openedWorkspace: session.workspace,
        third,
        installation: install,
      });
      assert.equal((await ensureLocalExtension(root, profile, artifact)).status, 'reused');
    }
  } finally {
    process.chdir(originalCwd);
  }
  assert.equal(contacts, 0);
  result.completed.push('two-distinct-callers-exact-native-cwd-no-foreign-ipc');
  const profile = profiles[0];
  const source = join(root, 'dist/tests/developmentProfileHost.js');
  const ownedPayload = join(session.temporary, 'payload.js');
  writeFileSync(ownedPayload, readFileSync(source));
  const payload = (file) => ({
    manifest: {
      name: 'normal-owned-fixture',
      publisher: 'devloom',
      version: '1.0.0',
      engines: { vscode: '^1.146.0' },
      main: './main.js',
    },
    files: { 'main.js': file },
  });
  const stagedFile = join(root, '.tools/local-vsix', `normal-${session.nonce}.js`);
  writeFileSync(stagedFile, readFileSync(ownedPayload), { flag: 'wx', mode: 0o600 });
  try {
    const first = buildLocalArtifact(root, payload(stagedFile));
    await ensureLocalExtension(root, profile, first);
    const settings = readFileSync(profile.settings);
    writeFileSync(stagedFile, '\n', { flag: 'a' });
    const changed = buildLocalArtifact(root, payload(stagedFile));
    assert.equal((await ensureLocalExtension(root, profile, changed)).status, 'updated');
    assert.deepEqual(readFileSync(profile.settings), settings);
    verifyInstalled(join(profile.extensions, 'devloom.normal-owned-fixture-1.0.0'), changed);
    result.completed.push('actual-native-owned-same-version-update');
    const upgradedPayload = payload(stagedFile);
    upgradedPayload.manifest.version = '1.0.1';
    const upgrade = await ensureLocalExtension(
      root,
      profile,
      buildLocalArtifact(root, upgradedPayload),
    );
    assert.equal(upgrade.status, 'updated');
    assert.equal(upgrade.receipt.version, '1.0.1');
    write(join(session.evidence, 'actual-owned-version-upgrade.json'), upgrade);
    await assert.rejects(ensureLocalExtension(root, profile, changed), /downgrade/);
    result.completed.push('actual-native-owned-version-upgrade');
  } finally {
    rmSync(stagedFile);
  }
  const invalid = join(session.temporary, 'corrupt.vsix');
  writeFileSync(invalid, 'not a zip archive', { mode: 0o600 });
  const runtime = nativeRuntime(root);
  await assert.rejects(
    nativeCLI(
      runtime.executable,
      [
        runtime.entry,
        '.',
        `--user-data-dir=${profiles[1].userData}`,
        `--extensions-dir=${profiles[1].extensions}`,
        `--install-extension=${invalid}`,
        '--do-not-sync',
      ],
      {
        cwd: runtime.cwd,
        env: {
          ...localEnvironment(root, session.env),
          ELECTRON_RUN_AS_NODE: '1',
          NODE_ENV: 'development',
        },
      },
    ),
    (error) => {
      write(join(session.evidence, 'actual-corrupt-native-error.json'), error.result);
      return error.result.code !== 0;
    },
  );
  result.completed.push('actual-native-corrupt-archive-refused');
  const incompatible = buildLocalArtifact(root, {
    manifest: {
      name: 'incompatible-fixture',
      publisher: 'devloom',
      version: '1.0.0',
      engines: { vscode: '^999.0.0' },
      main: './main.js',
    },
    files: { 'main.js': join(root, 'dist/tests/developmentProfileHost.js') },
  });
  const beforeNativeFailure = readFileSync(profiles[1].settings);
  await assert.rejects(ensureLocalExtension(root, profiles[1], incompatible), (error) => {
    write(join(session.evidence, 'actual-native-incompatible-error.json'), {
      message: error.message,
      result: error.result,
      log: incompatible.stage,
    });
    return error.result?.code !== 0;
  });
  assert.ok(existsSync(join(profiles[1].path, '.pending-devloom.incompatible-fixture.json')));
  assert.ok(existsSync(join(profiles[1].path, '.local-install-lock')));
  assert.deepEqual(readFileSync(profiles[1].settings), beforeNativeFailure);
  result.completed.push('actual-native-incompatible-engine-pending-preserved');
  const collisionProfile = developmentProfile(root, `qa-${session.nonce.slice(0, 12)}-collision`);
  profiles.push(collisionProfile);
  const collision = join(collisionProfile.extensions, 'devloom.devloom-bootstrap-unknown');
  mkdirSync(collision, { mode: 0o700 });
  writeFileSync(join(collision, 'sentinel'), session.nonce, { flag: 'wx', mode: 0o600 });
  await assert.rejects(
    ensureLocalExtension(root, collisionProfile, buildLocalArtifact(root)),
    /collision/,
  );
  assert.equal(readFileSync(join(collision, 'sentinel'), 'utf8'), session.nonce);
  write(join(session.evidence, 'actual-collision-preserved.json'), {
    path: collision,
    sentinel: readFileSync(join(collision, 'sentinel'), 'utf8'),
    lockPreserved: existsSync(join(collisionProfile.path, '.local-install-lock')),
  });
  result.completed.push('actual-own-id-collision-preserved');
  await session.prepareInstallation();
  let host = session.launch(true);
  await session.activation(host);
  let endpoint = await ownedTarget(host, session.profile, session.nonce);
  write(join(session.evidence, 'debug-ownership.json'), endpoint);
  ui = await CDP.connect(endpoint.target.webSocketDebuggerUrl);
  assert.equal((await stage('bridge-status')).active, false);
  await palette('Devloom: Verify Local Bridge');
  const active = await waitFor('palette autoactivation real Rust ready', async () => {
    const value = await stage('bridge-status');
    return value.active && value.diagnostics?.state === 'ready' && value;
  });
  assert.equal(active.mode, 1);
  assert.equal(active.appRoot, realpathSync(root));
  assert.ok(active.extensionPath.startsWith(session.profile.extensions + '/'));
  const pid = active.diagnostics.pid;
  await stage('bridge-stop');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const verified = await stage('bridge-verify');
  assert.ok(verified.result.hello);
  assert.equal(verified.result.echo.text, '한글 e\u0301 👨‍👩‍👧‍👦\nDevloom');
  await stage('bridge-stop');
  await stage('bridge-write');
  const settingBytes = readFileSync(session.profile.settings);
  result.completed.push('actual-command-palette-production-activation-rust-echo-reaped');
  await session.stage('restart', 'prepare');
  const backups = await waitFor('actual native dirty backup subtree', () => {
    const directory = join(session.profile.userData, 'Backups');
    if (!existsSync(directory)) return;
    const names = readdirSync(directory, { recursive: true });
    return (
      names.some(
        (name) =>
          lstatSync(join(directory, name)).isFile() &&
          readFileSync(join(directory, name), 'utf8').includes('BUFFER B'),
      ) && directory
    );
  });
  await delay(1500);
  await waitFor(
    'native backup writes settled',
    () => !readdirSync(backups, { recursive: true }).some((name) => name.endsWith('.vsctmp')),
  );
  modes = [
    backups,
    ...readdirSync(backups, { recursive: true })
      .filter((name) => !name.endsWith('.vsctmp'))
      .map((name) => join(backups, name)),
  ].map((path) => ({
    path,
    mode: lstatSync(path).mode & 0o777,
    directory: lstatSync(path).isDirectory(),
  }));
  for (const entry of modes) {
    assert.ok(!lstatSync(entry.path).isSymbolicLink());
    chmodSync(entry.path, entry.directory ? 0o500 : 0o400);
  }
  const file = modes.find((entry) => !entry.directory);
  assert.throws(() => writeFileSync(file.path, 'refusal-probe', { flag: 'a' }), { code: 'EACCES' });
  const before = (await session.stage('restart', 'backup-change')).data;
  await session.stage('restart', 'quit');
  const modal = await waitFor('native backup-error veto dialog', async () =>
    (await ui.modal()).find((dialog) => /backup|back up/i.test(dialog.text)),
  );
  assert.match(modal.text, /unsaved/i);
  const ok = modal.buttons.filter((button) => button.label === 'OK');
  assert.equal(ok.length, 1);
  write(join(session.evidence, 'actual-backup-refusal.json'), {
    modes,
    probe: 'EACCES',
    before,
    modal,
  });
  await ui.screenshot(join(session.evidence, 'backup-error-veto.png'));
  await ui.click(ok[0]);
  await waitFor('native veto dialog closed', async () => (await ui.modal()).length === 0);
  const after = (await session.stage('restart')).data;
  assert.deepEqual(after.git, before.git);
  assert.deepEqual(after.documents, before.documents);
  assert.equal(after.draft, before.draft);
  assert.equal(host.closed, false);
  for (const entry of modes) chmodSync(entry.path, entry.mode);
  modes = [];
  ui.close();
  ui = undefined;
  await session.quit(host);
  host = session.launch(false);
  await session.activation(host);
  const restored = (await session.stage('restart')).data;
  assert.deepEqual(restored.git, before.git);
  assert.equal(restored.draft, before.draft);
  assert.equal(restored.documents[0].text, before.documents[0].text);
  assert.equal(restored.documents[0].dirty, true);
  const persisted = await stage('bridge-status');
  assert.equal(persisted.globalState, session.nonce);
  assert.equal(persisted.workspaceState, session.nonce);
  assert.deepEqual(readFileSync(session.profile.settings), settingBytes);
  result.completed.push(
    'actual-backup-write-refusal-native-ok-veto-clean-reopen-b',
    'normal-reuse-preserves-settings-memento',
  );
  await session.quit(host);
  session = new Session(evidence);
  sessions.push(session);
  await session.prepareInstallation();
  const syntheticRoot = join(realpathSync(session.temporary), 'validated-missing-helper-root');
  for (const directory of ['extensions/devloom-bootstrap', 'crates/devloom-sidecar/target/debug'])
    mkdirSync(join(syntheticRoot, directory), { recursive: true, mode: 0o700 });
  for (const file of [
    'package.json',
    'upstream.lock.json',
    'extensions/devloom-bootstrap/package.json',
  ])
    writeFileSync(join(syntheticRoot, file), readFileSync(join(root, file)), {
      flag: 'wx',
      mode: 0o600,
    });
  const missingPayload = bootstrapPayload(root);
  missingPayload.manifest.devloomLocal.sourceRoot = syntheticRoot;
  const missingArtifact = buildLocalArtifact(root, missingPayload);
  await ensureLocalExtension(root, session.profile, missingArtifact);
  session.env.DEVLOOM_APP_ROOT = syntheticRoot;
  host = session.launch(true);
  await session.activation(host);
  endpoint = await ownedTarget(host, session.profile, session.nonce);
  ui = await CDP.connect(endpoint.target.webSocketDebuggerUrl);
  const missingPath = join(syntheticRoot, 'crates/devloom-sidecar/target/debug/devloom-sidecar');
  assert.equal(existsSync(missingPath), false);
  await palette('Devloom: Verify Local Bridge');
  const nativeMissing = await waitFor(
    'actual native installed missing-helper activation error',
    () => {
      const directory = join(session.profile.userData, 'logs');
      const names = readdirSync(directory, { recursive: true }).filter((name) =>
        name.endsWith('exthost.log'),
      );
      return names
        .map((name) => readFileSync(join(directory, name), 'utf8'))
        .find((text) => text.includes(missingPath) && text.includes('ENOENT'));
    },
  );
  write(join(session.evidence, 'actual-synthetic-root-missing-helper.json'), {
    syntheticRoot,
    missingPath,
    nativeMissing,
    nativeGitAppRoot: join(root, 'vendor/code-oss'),
    ownInstalledPath: join(session.profile.extensions, 'devloom.devloom-bootstrap-0.0.1'),
  });
  await ui.screenshot(join(session.evidence, 'actual-missing-helper.png'));
  for (const dialog of await ui.modal()) {
    const buttons = dialog.buttons.filter((button) => button.label === 'OK');
    if (buttons.length === 1) await ui.click(buttons[0]);
  }
  ui.close();
  ui = undefined;
  await session.quit(host);
  result.completed.push('actual-normal-synthetic-validated-root-missing-helper');
  session = new Session(evidence);
  sessions.push(session);
  await session.prepareInstallation();
  host = session.launch(true);
  await session.activation(host);
  endpoint = await ownedTarget(host, session.profile, session.nonce);
  ui = await CDP.connect(endpoint.target.webSocketDebuggerUrl);
  await stage('bridge-extensions');
  const row = await waitFor('own installed extension row', () =>
    ui.evaluate(
      `(() => {const rows=[...document.querySelectorAll('.extension-list-item')].filter(e=>e.innerText.includes('Devloom Local Bootstrap')); if(rows.length!==1)return; const r=rows[0].getBoundingClientRect(); return r.width ? {x:r.x+r.width/2,y:r.y+20,width:r.width,height:r.height}:null;})()`,
    ),
  );
  await ui.click(row);
  const disable = await waitFor('native own extension Disable action', () =>
    ui.evaluate(
      `(() => {const items=[...document.querySelectorAll('.extension-editor .action-label')].filter(e=>e.innerText.trim()==='Disable'); if(items.length!==1)return; const r=items[0].getBoundingClientRect();return r.width?{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height}:null;})()`,
    ),
  );
  await ui.click(disable);
  await ui.screenshot(join(session.evidence, 'native-disabled.png'));
  write(
    join(session.evidence, 'native-disabled-dom.json'),
    await ui.evaluate('document.body.innerText'),
  );
  ui.close();
  ui = undefined;
  await session.quit(host);
  host = session.launch(false);
  await session.activation(host);
  assert.equal((await stage('bridge-status')).active, false);
  assert.equal((await stage('bridge-status')).present, false);
  const changedBootstrap = bootstrapPayload(root);
  changedBootstrap.manifest.displayName += ' synthetic changed payload';
  const changed = buildLocalArtifact(root, changedBootstrap);
  await assert.rejects(
    ensureLocalExtension(root, session.profile, changed),
    /active|process remains/,
  );
  assert.equal(host.closed, false);
  assert.equal(existsSync(join(session.profile.path, '.local-install-lock')), false);
  assert.equal(
    existsSync(join(session.profile.path, '.pending-devloom.devloom-bootstrap.json')),
    false,
  );
  const refusalLog = readdirSync(changed.stage).filter((name) => name.startsWith('native-'));
  assert.equal(refusalLog.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(changed.stage, refusalLog[0]), 'utf8')).calls, []);
  result.completed.push(
    'native-disabled-preference-preserved-no-autoenable',
    'changed-live-owned-payload-refused-main-survives',
  );
  await session.quit(host);
  const inactiveRetry = await ensureLocalExtension(root, session.profile, changed);
  assert.equal(inactiveRetry.status, 'updated');
  write(join(session.evidence, 'changed-live-inactive-retry.json'), inactiveRetry);
  result.status = 'pass';
} catch (error) {
  result.error = error.stack ?? String(error);
  if (ui) {
    await ui.screenshot(join(session.evidence, 'normal-failure.png')).catch(() => {});
    write(
      join(session.evidence, 'normal-failure-dom.json'),
      await ui.evaluate('document.body.innerText').catch(String),
    );
  }
} finally {
  for (const entry of modes) chmodSync(entry.path, entry.mode);
  ui?.close();
  foreign?.close();
  result.cleanup = { forced: false, leftovers: [] };
  result.sessions = sessions.map((item) => ({
    nonce: item.nonce,
    session: item.id,
    evidence: item.evidence,
  }));
  for (const item of sessions) {
    const cleanup = await item.cleanup();
    result.cleanup.forced ||= cleanup.forced;
    result.cleanup.leftovers.push(...cleanup.leftovers);
  }
  for (const profile of profiles) {
    try {
      assert.equal(developmentProfile(root, profile.id).created, false);
      assert.ok(profile.id.includes(result.nonce.slice(0, 12)));
      rmSync(profile.path, { recursive: true });
    } catch (error) {
      result.cleanup.leftovers.push(String(error));
    }
  }
  if (result.cleanup.forced || result.cleanup.leftovers.length) result.status = 'fail';
  await delay(50);
  write(join(evidence, 'normal-result.json'), {
    ...result,
    contacts,
    finished: Date.now(),
  });
}
process.stdout.write(
  `Normal installation ${result.status}: ${join(evidence, 'normal-result.json')}\n`,
);
if (result.status !== 'pass') process.exitCode = 1;
