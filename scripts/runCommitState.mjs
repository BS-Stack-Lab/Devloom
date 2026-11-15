import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CDP, ownedTarget, waitFor } from './commitStateUI.mjs';
import { Session, write } from './commitStateSession.mjs';
import { contents, fileNames, template } from '../dist/tests/commitStateFixtures.js';

const session = new Session(process.env.DEVLOOM_EVIDENCE_DIR);
const result = {
  nonce: session.nonce,
  session: session.id,
  started: Date.now(),
  status: 'fail',
  completed: [],
  observations: [],
};
let ui;
let timedOut = false;
const deadline = setTimeout(() => {
  timedOut = true;
  ui?.close(new Error('Suite deadline'));
}, 360000);
const record = (value) => {
  result.observations.push(value);
  return value.data;
};
const stage = async (name, action) => record(await session.stage(name, action));
const partial = fileNames(session.nonce)[0];
const sentinel = fileNames(session.nonce)[2];
const expected = contents(session.nonce, partial);
function unchanged(before, after) {
  assert.deepEqual(after.git, before.git);
  assert.equal(after.draft, before.draft);
  assert.deepEqual(after.documents, before.documents);
}
function committed(before, after, saved = false) {
  assert.notEqual(after.git.head, before.git.head);
  assert.equal(after.git.files[partial].head.text, saved ? expected.B : expected.I);
  assert.equal(after.git.files[partial].index.text, saved ? expected.B : expected.I);
  assert.equal(after.git.files[partial].disk.text, saved ? expected.B : expected.D);
  const document = after.documents.find((item) => item.uri.endsWith(partial));
  assert.equal(document.text, expected.B);
  assert.equal(document.dirty, !saved);
  assert.deepEqual(after.git.files[sentinel], before.git.files[sentinel]);
  assert.equal(after.git.rawCommit.split('\n\n').slice(1).join('\n\n'), `${before.draft}\n`);
  assert.equal(after.git.message, `${before.draft}\n\n`);
  assert.equal(after.draft, template(session.nonce));
}
async function choice(name, label, text = partial) {
  await stage(name, 'commit');
  const warning = await waitFor('warning before snapshot', async () => (await ui.modal())[0]);
  assert.ok(warning.text.includes(text), warning.text);
  const visible = await stage(name);
  write(join(session.evidence, `${name}-warning-snapshot.json`), {
    nonce: session.nonce,
    session: session.id,
    activation: session.active.activation,
    observed: Date.now(),
    warning,
    visible,
  });
  await ui.choice(label, text, session.evidence, `${name}-${session.sequence}`, session.active);
  if (name === 'failure') {
    const errorModal = await waitFor('native hook error', async () => (await ui.modal())[0]);
    assert.match(errorModal.text, /Git|commit|hook/i);
    await ui.screenshot(join(session.evidence, 'hook-error-visible.png'));
    write(join(session.evidence, 'hook-error-modal.json'), {
      nonce: session.nonce,
      session: session.id,
      activation: session.active.activation,
      observed: Date.now(),
      errorModal,
    });
    const dismiss = errorModal.buttons.filter((button) => button.label === 'Cancel');
    assert.equal(dismiss.length, 1);
    await ui.click(dismiss[0]);
    await waitFor('error dismissal', async () => (await ui.modal()).length === 0);
  }
  const after = record(await session.settled(name));
  for (const [other, value] of Object.entries(visible.repositories))
    if (other !== name)
      assert.deepEqual(after.repositories[other], value, `Unrelated repository changed: ${other}`);
  return after;
}
try {
  await session.prepareInstallation();
  let host = session.launch(true);
  await session.activation(host);
  const endpoint = await ownedTarget(host, session.profile, session.nonce);
  write(join(session.evidence, 'debug-ownership.json'), {
    nonce: session.nonce,
    session: session.id,
    activation: session.active.activation,
    observed: Date.now(),
    ...endpoint,
  });
  ui = await CDP.connect(endpoint.target.webSocketDebuggerUrl);
  const initial = await stage('index');
  assert.equal(initial.draft, template(session.nonce));
  const edited = await stage('index', 'prepare');
  await stage('index', 'template-change');
  assert.equal((await stage('index')).draft, edited.draft);
  result.completed.push('native-template-edited-draft');
  const cancel = await stage('cancel', 'prepare');
  unchanged(cancel, await choice('cancel', 'Cancel'));
  result.completed.push('native-cancel-preserves-h-i-d-b-draft');
  const index = await stage('index');
  const indexAfter = await choice('index', 'Commit Changes');
  assert.notEqual(indexAfter.git.head, index.git.head);
  assert.equal(indexAfter.git.files[partial].head.text, expected.I);
  assert.equal(indexAfter.git.files[partial].disk.text, expected.D);
  assert.equal(indexAfter.documents[0].text, expected.B);
  assert.equal(indexAfter.documents[0].dirty, true);
  assert.equal(indexAfter.draft, `${template(session.nonce)}\nchanged`);
  assert.equal(indexAfter.git.rawCommit.split('\n\n').slice(1).join('\n\n'), `${index.draft}\n`);
  assert.deepEqual(indexAfter.git.files[sentinel], index.git.files[sentinel]);
  result.completed.push('native-commit-index-exact-message-template-reset');
  await stage('index', 'mount');
  await ui.screenshot(join(session.evidence, 'history-mounted.png'));
  write(
    join(session.evidence, 'history-dom.json'),
    await ui.evaluate(`[...document.querySelectorAll('.scm-view')].map(e=>e.outerHTML)`),
  );
  await ui.focusInput('index', session.nonce);
  await ui.key('a', 'KeyA', 4, 65);
  const historyValue = `history ${session.nonce}`;
  await ui.call('Input.insertText', { text: historyValue });
  assert.equal((await stage('index')).draft, historyValue);
  await ui.key('ArrowUp', 'ArrowUp', 1, 38);
  assert.equal((await stage('index')).draft, index.draft);
  await ui.screenshot(join(session.evidence, 'history-previous.png'));
  await ui.key('ArrowDown', 'ArrowDown', 1, 40);
  assert.equal((await stage('index')).draft, historyValue);
  await ui.screenshot(join(session.evidence, 'history-next.png'));
  result.completed.push('native-history-key-input');
  const save = await stage('save', 'prepare');
  committed(save, await choice('save', 'Save All & Commit Changes'), true);
  result.completed.push('native-save-replaces-partial-staging');
  const plural = await stage('plural', 'prepare');
  unchanged(plural, await choice('plural', 'Cancel', '2 unsaved files'));
  result.completed.push('native-plural-warning');
  const scope = await stage('scope', 'prepare');
  await stage('scope', 'commit');
  const scopeAfter = record(await session.settled('scope'));
  assert.notEqual(scopeAfter.git.head, scope.git.head);
  assert.equal(scopeAfter.git.files[partial].head.text, expected.H);
  assert.deepEqual(scopeAfter.documents, scope.documents);
  assert.equal((await ui.modal()).length, 0);
  result.completed.push('native-excludes-unstaged-untitled-outside');
  const never = await stage('never', 'prepare');
  await stage('never', 'commit');
  committed(never, record(await session.settled('never')));
  assert.equal((await ui.modal()).length, 0);
  result.completed.push('native-never-commits-index');
  const failure = await stage('failure', 'prepare');
  const failureAfter = await choice('failure', 'Commit Changes');
  assert.equal(failureAfter.git.hookCount, 1);
  const failureComparable = { ...failureAfter, git: { ...failureAfter.git, hookCount: 0 } };
  unchanged(failure, failureComparable);
  await ui.screenshot(join(session.evidence, 'hook-error.png'));
  const visibleError = await ui.evaluate('document.body.innerText');
  assert.match(visibleError, /Git|commit|hook/i);
  write(join(session.evidence, 'hook-error.json'), {
    nonce: session.nonce,
    activation: session.active.activation,
    observed: Date.now(),
    visibleError,
  });
  assert.equal((await stage('failure')).git.hookCount, 1);
  result.completed.push('native-hook-failure-no-retry');
  const held = await stage('held', 'prepare');
  await stage('held', 'commit');
  await ui.choice('Commit Changes', partial, session.evidence, 'held', session.active);
  const holding = await waitFor(
    'held hook entered',
    async () => {
      const value = await stage('held');
      return value.git.hookCount === 1 && value;
    },
    10000,
  );
  assert.equal(holding.operation.state, 'pending');
  assert.equal(holding.git.head, held.git.head);
  assert.deepEqual(holding.documents, held.documents);
  await stage('held', 'release');
  committed(held, record(await session.settled('held')));
  result.completed.push('native-held-hook-bounded-release');
  const restart = await stage('restart', 'prepare');
  const failureBeforeRestart = await stage('failure');
  const active = session.active;
  ui.close();
  ui = undefined;
  await session.quit(host);
  host = session.launch(false);
  const reopened = await session.activation(host);
  assert.notEqual(reopened.activation, active.activation);
  assert.notEqual(reopened.mainPid, active.mainPid);
  assert.equal(reopened.storageUri, active.storageUri);
  assert.equal(reopened.globalStorageUri, active.globalStorageUri);
  const restored = await waitFor('native hot-exit restoration', async () => {
    const value = await stage('restart');
    assert.deepEqual(value.git, restart.git);
    return (
      value.documents.some((document) => document.text === expected.B && document.dirty) && value
    );
  });
  assert.deepEqual(restored.git, restart.git);
  assert.equal(restored.draft, restart.draft);
  assert.equal(restored.documents[0].text, expected.B);
  assert.equal(restored.documents[0].dirty, true);
  const restoredFailure = await stage('failure');
  assert.equal(restoredFailure.draft, failureBeforeRestart.draft);
  assert.deepEqual(restoredFailure.git, failureBeforeRestart.git);
  result.completed.push('production-start-hotexit-dirty-draft-no-replay');
  await stage('failure', 'retry');
  await stage('never', 'prepare');
  await stage('failure', 'commit');
  const retried = record(await session.settled('failure'));
  committed(failure, retried);
  assert.equal(retried.git.hookCount, 1);
  result.completed.push('explicit-retry-success');
  await session.quit(host);
  assert.equal(timedOut, false);
  result.status = 'pass';
} catch (error) {
  result.error = error instanceof Error ? error.stack : String(error);
  if (ui) {
    await ui.screenshot(join(session.evidence, 'failure.png')).catch(() => {});
    write(
      join(session.evidence, 'failure-dom.json'),
      await ui.evaluate('document.body.innerText').catch(String),
    );
  }
} finally {
  clearTimeout(deadline);
  ui?.close();
  result.cleanup = await session.cleanup();
  if (result.cleanup.forced || result.cleanup.leftovers.length || timedOut) result.status = 'fail';
  result.finished = Date.now();
  write(join(session.evidence, 'run-result.json'), result);
}
process.stdout.write(
  `Commit state ${result.status}: ${join(session.evidence, 'run-result.json')}\n`,
);
if (result.status !== 'pass') process.exitCode = 1;
