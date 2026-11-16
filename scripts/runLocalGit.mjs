import { randomBytes, randomUUID } from 'node:crypto';
import { launchOwned } from './localGitSession.mjs';
import { observePresentation } from './localGitPresentation.mjs';
import { sourceBinding, digest } from './p1CoverageEvidence.mjs';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  realpathSync,
  cpSync,
} from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { prepare, root, upstream } from './upstream.mjs';
import { createEvidenceDirectory } from './runExtensionHost.mjs';
const require = createRequire(import.meta.url);
const {
  setupFixture,
  snapshot,
  configureScenario,
  prepareConcurrent,
  git,
} = require('../dist/tests/localGitFixtures.js');
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function wait(path) {
  const deadline = Date.now() + 40000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`Rendezvous timeout: ${path}`);
    await delay(50);
  }
}
function launch(
  temporary,
  evidence,
  runtime,
  profile,
  test,
  repositoryPath = join(temporary, 'repository'),
  scenario = 'shared',
) {
  const ownEvidence = join(evidence, profile);
  mkdirSync(ownEvidence);
  const userData = join(realpathSync(temporary), `p-${nonce}-${profile}`);
  mkdirSync(join(userData, 'User'), { recursive: true });
  writeFileSync(
    join(userData, 'User/settings.json'),
    JSON.stringify({
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
      'extensions.autoCheckUpdates': false,
      'extensions.autoUpdate': false,
      'chat.disableAIFeatures': true,
      'security.workspace.trust.enabled': profile !== 'untrusted' ? false : true,
      'git.autofetch': false,
      ...(profile === 'missing' ? {} : { 'git.path': join(temporary, 'fixture-git') }),
      'window.title': `P1 ${nonce}`,
      'git.confirmEmptyCommits': false,
      'git.confirmSync': false,
      'git.postCommitCommand': 'none',
      ...(profile === 'unsupported' ? { 'git.path': join(temporary, 'old-git') } : {}),
    }),
  );
  const host = launchOwned({
    command: join(upstream, 'scripts/code.sh'),
    args: [
      repositoryPath,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${join(temporary, `extensions-${profile}`)}`,
      `--extensionDevelopmentPath=${join(root, 'extensions/devloom-bootstrap')}`,
      `--extensionTestsPath=${join(root, 'dist/tests', `${test}.js`)}`,
      '--disable-telemetry',
      '--disable-updates',
      '--force-disable-user-env',
      '--skip-welcome',
      '--skip-release-notes',
      ...(profile === 'untrusted' ? [] : ['--disable-workspace-trust']),
      ...[
        'GitHub.copilot-chat',
        'GitHub.copilot',
        'vscode.github-authentication',
        'vscode.microsoft-authentication',
      ].map((id) => `--disable-extension=${id}`),
      ...(scenario.startsWith('p1-') ? ['--remote-debugging-port=0'] : []),
    ],
    cwd: upstream,
    env: {
      ...process.env,
      PATH: profile === 'missing' ? join(temporary, 'no-git-bin') : process.env.PATH,
      VSCODE_DEV: '1',
      VSCODE_SKIP_PRELAUNCH: '1',
      DEVLOOM_EVIDENCE_DIR: ownEvidence,
      DEVLOOM_GIT_FIXTURE: temporary,
      DEVLOOM_GIT_TEST_DIRECTORY: runtime,
      DEVLOOM_GIT_PROFILE: profile,
      DEVLOOM_GIT_REPOSITORY: repositoryPath,
      DEVLOOM_GIT_SCENARIO: scenario,
      DEVLOOM_GIT_NONCE: nonce,
      DEVLOOM_GIT_SESSION: sessionId,
      DEVLOOM_GIT_SOURCE_DIGEST: sourceDigest,
    },
    fixtureRoot: temporary,
    profile: userData,
    nonce,
    sessionId: `${sessionId}-${profile}`,
    sourceRoot: root,
    evidence: ownEvidence,
    timeoutMs: scenario.startsWith('p1-') ? 180000 : 100000,
  });
  if (scenario.startsWith('p1-'))
    host.presentation = observePresentation(host, ownEvidence, { nonce, sessionId, sourceDigest });
  return host;
}
async function group(evidence, concurrent, profile = 'normal', alias = false, crash = '', p1 = '') {
  const temporary = realpathSync(mkdtempSync('/tmp/dlg-fixture-'));
  const marker = join(temporary, '.fixture-owner.json');
  writeFileSync(marker, JSON.stringify({ nonce, sessionId }), { flag: 'wx', mode: 0o600 });
  const runtime = realpathSync(mkdtempSync('/tmp/dlg-runtime-'));
  writeFileSync(join(runtime, '.fixture-owner.json'), JSON.stringify({ nonce, sessionId }), {
    flag: 'wx',
    mode: 0o600,
  });
  const hosts = [];
  const terminate = () => Promise.all(hosts.map((host) => host.terminate()));
  const timer = setTimeout(() => void terminate(), p1 ? 180000 : 100000);
  try {
    setupFixture(temporary);
    if (concurrent) {
      const second = prepareConcurrent(temporary, alias);
      hosts.push(launch(temporary, evidence, runtime, 'a', 'localGitConcurrencyHost'));
      await wait(join(temporary, 'ready-a'));
      hosts.push(
        launch(
          temporary,
          evidence,
          runtime,
          'b',
          'localGitConcurrencyHost',
          second,
          crash || (alias ? 'alias' : 'shared'),
        ),
      );
      await Promise.all(['a', 'b'].map((role) => wait(join(temporary, `ready-${role}`))));
      writeFileSync(join(temporary, 'go-a'), 'go');
      await wait(join(temporary, 'hook-ready'));
      writeFileSync(join(temporary, 'go-b'), 'go');
      await wait(join(temporary, 'requested-b'));
      await delay(500);
      const heldIndex = git(second, ['show', ':fixture.txt']);
      if ((alias || crash) && existsSync(join(evidence, 'b/result.json')))
        throw new Error('Second host completed while first hook held the lease');
      writeFileSync(
        join(evidence, 'held-observation.json'),
        JSON.stringify(
          {
            heldIndex,
            ownership: JSON.parse(readFileSync(join(runtime, 'ownership.json'), 'utf8')),
            observed: Date.now(),
          },
          null,
          2,
        ),
      );
      if (crash) {
        const ownership = JSON.parse(readFileSync(join(runtime, 'ownership.json'), 'utf8')).record;
        writeFileSync(join(evidence, 'before-crash.json'), JSON.stringify(ownership, null, 2));
        const victim = hosts[0].captureVictim(
          crash === 'worker-crash' ? ownership.clientPid : ownership.mainPid,
        );
        if (!hosts[0].crash(victim)) throw new Error('Owned crash authorization failed');
        await delay(300);
        writeFileSync(join(temporary, 'crashed'), 'crashed');
      }
      writeFileSync(join(temporary, 'release'), String(Date.now()));
    } else {
      configureScenario(temporary, profile);
      hosts.push(
        launch(
          temporary,
          evidence,
          runtime,
          profile,
          p1 ? 'localGitP1Host' : 'localGitHost',
          join(temporary, 'repository'),
          p1 || 'shared',
        ),
      );
    }
    const results = crash
      ? [await hosts[1].completion]
      : await Promise.all(hosts.map((host) => host.completion));
    writeFileSync(
      join(evidence, 'final-state.json'),
      JSON.stringify(snapshot(join(temporary, 'repository')), null, 2),
    );
    if (existsSync(join(runtime, 'ownership.json')))
      cpSync(join(runtime, 'ownership.json'), join(evidence, 'ownership.json'));
    if (crash === 'main-crash') {
      const restart = launch(temporary, evidence, runtime, 'restart', 'localGitConcurrencyHost');
      hosts.push(restart);
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const path = join(evidence, 'restart/host.log');
        if (existsSync(path) && /ECONNREFUSED|quarantined/.test(readFileSync(path, 'utf8'))) break;
        await delay(100);
      }
      const restartLog = readFileSync(join(evidence, 'restart/host.log'), 'utf8');
      if (
        !/ECONNREFUSED|quarantined/.test(restartLog) ||
        existsSync(join(evidence, 'restart/result.json'))
      )
        throw new Error('Main restart refusal was not observed');
      writeFileSync(
        join(evidence, 'restart-refused.json'),
        JSON.stringify(
          {
            observed: Date.now(),
            journal: JSON.parse(readFileSync(join(runtime, 'ownership.json'), 'utf8')),
          },
          null,
          2,
        ),
      );
    }
    if (
      results.some(
        (item) => item.status !== 'pass' || item.code !== 0 || item.result?.status !== 'pass',
      )
    )
      throw new Error(`Actual Git host failed: ${evidence}`);
  } finally {
    clearTimeout(timer);
    const cleanup = await terminate();
    await Promise.allSettled(hosts.map((host) => host.completion));
    await Promise.allSettled(
      hosts.filter((host) => host.presentation).map((host) => host.presentation),
    );
    const valid =
      readFileSync(marker, 'utf8') === JSON.stringify({ nonce, sessionId }) &&
      readFileSync(join(runtime, '.fixture-owner.json'), 'utf8') ===
        JSON.stringify({ nonce, sessionId });
    const safe =
      valid &&
      cleanup.every(Boolean) &&
      hosts.every((host) => host.state.cleanup?.confirmedClosed && host.state.cleanup?.markerValid);
    writeFileSync(
      join(evidence, 'cleanup.json'),
      JSON.stringify(
        {
          safe,
          hosts: hosts.map((host) => host.state),
          leftovers: safe ? [] : [temporary, runtime],
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    if (safe) {
      rmSync(temporary, { recursive: true, force: true });
      rmSync(runtime, { recursive: true, force: true });
    }
  }
}
prepare();
const nonce = randomBytes(16).toString('hex'),
  sessionId = randomUUID(),
  source = sourceBinding(root),
  sourceDigest = digest(JSON.stringify(source));
const parent = process.env.DEVLOOM_EVIDENCE_DIR;
if (
  !parent ||
  !isAbsolute(parent) ||
  resolve(parent) === root ||
  resolve(parent).startsWith(root + '/')
)
  throw new Error('Set an absolute external DEVLOOM_EVIDENCE_DIR');
const scenarios = {
  normal: (path) => group(path, false),
  concurrency: (path) => group(path, true),
  'linked-worktree': (path) => group(path, true, 'normal', true),
  untrusted: (path) => group(path, false, 'untrusted'),
  'missing-git': (path) => group(path, false, 'missing'),
  'unsupported-git': (path) => group(path, false, 'unsupported'),
  'worker-crash': (path) => group(path, true, 'normal', false, 'worker-crash'),
  'main-crash': (path) => group(path, true, 'normal', false, 'main-crash'),
};
const baseScenarios = Object.keys(scenarios);
scenarios['p1-changes'] = (path) => group(path, false, 'p1-changes', false, '', 'p1-changes');
scenarios['p1-sync'] = (path) => group(path, false, 'p1-sync', false, '', 'p1-sync');
const selected =
  process.env.DEVLOOM_LOCAL_GIT_SCENARIOS === undefined
    ? baseScenarios
    : process.env.DEVLOOM_LOCAL_GIT_SCENARIOS.split(',').map((name) => name.trim());
if (
  !selected.length ||
  new Set(selected).size !== selected.length ||
  selected.some((name) => !Object.hasOwn(scenarios, name))
)
  throw new Error('Unknown, empty or duplicate local Git scenario selector');
const evidence = createEvidenceDirectory(parent);
const result = {
  status: 'fail',
  selected,
  completed: [],
  fullSuite:
    selected.length === baseScenarios.length &&
    baseScenarios.every((name) => selected.includes(name)),
  fullBaseSuite: false,
  targetedP1Complete: false,
  baseScenarios,
  nonce,
  sessionId,
  source,
  sourceDigest,
  startedAt: new Date().toISOString(),
  finishedAt: '',
};
try {
  for (const name of selected) {
    const path = join(evidence, name);
    mkdirSync(path);
    await scenarios[name](path);
    result.completed.push(name);
  }
  result.fullBaseSuite = baseScenarios.every((name) => result.completed.includes(name));
  result.targetedP1Complete = ['p1-changes', 'p1-sync'].every((name) =>
    result.completed.includes(name),
  );
  result.status = 'pass';
  process.stdout.write(
    `Actual local Git hosts passed (${result.fullSuite ? 'full suite' : 'subset only'}: ${selected.join(',')}): ${evidence}\n`,
  );
} finally {
  result.finishedAt = new Date().toISOString();
  writeFileSync(join(evidence, 'run-result.json'), JSON.stringify(result, null, 2));
}
