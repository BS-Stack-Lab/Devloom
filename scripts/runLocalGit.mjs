import { spawn, execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  createWriteStream,
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
  const userData = join(temporary, `profile-${profile}`);
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
      'git.confirmSync': false,
      'git.postCommitCommand': 'none',
      ...(profile === 'unsupported' ? { 'git.path': join(temporary, 'old-git') } : {}),
    }),
  );
  const log = createWriteStream(join(ownEvidence, 'host.log'), { flags: 'wx' });
  const child = spawn(
    join(upstream, 'scripts/code.sh'),
    [
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
    ],
    {
      cwd: upstream,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
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
      },
    },
  );
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const completion = new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      log.end();
      const path = join(ownEvidence, 'result.json');
      const result = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
      writeFileSync(
        join(ownEvidence, 'launcher-result.json'),
        JSON.stringify({ pid: child.pid, code, signal, result }, null, 2),
      );
      done({ code, signal, result });
    });
  });
  return { child, completion };
}
async function group(evidence, concurrent, profile = 'normal', alias = false, crash = '') {
  const temporary = mkdtempSync('/tmp/dlg-fixture-');
  const runtime = mkdtempSync('/tmp/dlg-runtime-');
  const hosts = [];
  const terminate = () => {
    for (const host of hosts) {
      try {
        process.kill(-host.child.pid, 'SIGKILL');
      } catch {}
    }
  };
  const timer = setTimeout(terminate, 100000);
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
      const heldIndex = execFileSync('git', ['show', ':fixture.txt'], {
        cwd: second,
        encoding: 'utf8',
      });
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
        process.kill(crash === 'worker-crash' ? ownership.clientPid : ownership.mainPid, 'SIGKILL');
        await delay(300);
        writeFileSync(join(temporary, 'crashed'), 'crashed');
      }
      writeFileSync(join(temporary, 'release'), String(Date.now()));
    } else {
      configureScenario(temporary, profile);
      hosts.push(launch(temporary, evidence, runtime, profile, 'localGitHost'));
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
    if (results.some((item) => item.code !== 0 || item.result?.status !== 'pass'))
      throw new Error(`Actual Git host failed: ${evidence}`);
  } finally {
    clearTimeout(timer);
    terminate();
    await Promise.allSettled(hosts.map((host) => host.completion));
    await delay(100);
    rmSync(temporary, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
}
prepare();
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
const selected =
  process.env.DEVLOOM_LOCAL_GIT_SCENARIOS === undefined
    ? Object.keys(scenarios)
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
  fullSuite: selected.length === Object.keys(scenarios).length,
};
try {
  for (const name of selected) {
    const path = join(evidence, name);
    mkdirSync(path);
    await scenarios[name](path);
    result.completed.push(name);
  }
  result.status = 'pass';
  process.stdout.write(
    `Actual local Git hosts passed (${result.fullSuite ? 'full suite' : 'subset only'}: ${selected.join(',')}): ${evidence}\n`,
  );
} finally {
  writeFileSync(join(evidence, 'run-result.json'), JSON.stringify(result, null, 2));
}
