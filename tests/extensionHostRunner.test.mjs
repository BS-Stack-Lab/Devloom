import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  lstatSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  assertPreparedArtifacts,
  checkSocketBounds,
  createEvidenceDirectory,
  isolatedEnvironment,
  makeOwnerFixture,
  runExtensionHost,
  removeFixture,
  startOwnedHost,
} from '../scripts/runExtensionHost.mjs';
import { nativeRuntime } from '../scripts/localExtensionInstall.mjs';
import { groupMembers, launchOwned, probeProcess } from '../scripts/localGitSession.mjs';

const parent = process.env.DEVLOOM_EVIDENCE_DIR;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function evidence() {
  assert.ok(parent && parent.startsWith('/'), 'Set external absolute DEVLOOM_EVIDENCE_DIR');
  return mkdtempSync(join(parent, 'extension-host-unit-'));
}

function writeQaEvidence(name, value) {
  const path = join(parent, `${name}-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  return path;
}

function readTreeFiles(directory) {
  return [
    ...(function* files(root) {
      for (const name of readdirSync(root)) {
        const path = join(root, name);
        const stat = lstatSync(path);
        if (stat.isDirectory()) yield* files(path);
        else yield readFileSync(path, 'utf8');
      }
    })(directory),
  ];
}

function scratchInventory(root) {
  return [
    ...(function* walk(directory) {
      for (const name of readdirSync(directory).sort()) {
        const path = join(directory, name);
        const stat = lstatSync(path);
        yield {
          path: path.slice(root.length + 1),
          mode: stat.mode & 0o777,
          kind: stat.isDirectory() ? 'directory' : 'file',
          sha256: stat.isFile()
            ? createHash('sha256').update(readFileSync(path)).digest('hex')
            : null,
        };
        if (stat.isDirectory()) yield* walk(path);
      }
    })(root),
  ];
}

function launchSynthetic(fixture, directory, script, options = {}) {
  const env = isolatedEnvironment(directory, fixture.paths.g);
  return startOwnedHost({
    runtime: { executable: process.execPath, cwd: fixture.fixtureRoot },
    fixture,
    evidence: directory,
    env,
    timeoutMs: options.timeoutMs ?? 3000,
    probes: options.probes,
    launch: (configuration) =>
      launchOwned({
        ...configuration,
        command: process.execPath,
        args: ['-e', script, '--', `--user-data-dir=${configuration.profile}`],
        cwd: fixture.fixtureRoot,
      }),
  });
}

function startSentinel(directory) {
  const path = join(directory, 'independent-sentinel');
  writeFileSync(path, 'sentinel bytes', { flag: 'wx', mode: 0o600 });
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  const identity = probeProcess(child.pid);
  return {
    child,
    identity,
    path,
    async verify() {
      const current = probeProcess(identity.pid);
      assert.equal(current.uid, identity.uid);
      assert.equal(current.startIdentity, identity.startIdentity);
      assert.equal(current.detachedPgid, identity.detachedPgid);
      assert.equal(readFileSync(path, 'utf8'), 'sentinel bytes');
    },
    async stop() {
      const current = probeProcess(identity.pid);
      assert.equal(current.startIdentity, identity.startIdentity);
      assert.equal(current.detachedPgid, identity.detachedPgid);
      process.kill(-identity.detachedPgid, 'SIGTERM');
      await new Promise((done) => child.once('close', done));
    },
  };
}

async function waitFor(predicate, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error('SYNTHETIC_FIXTURE_TIMEOUT');
}

test('synthetic routing removes inherited profile, Git and Node injection controls', (t) => {
  const scratch = evidence();
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const measurements = join(scratch, 'compile-cache-measurements');
  const compileRoot = join(scratch, 'compile-cache-root');
  writeFileSync(measurements, 'untouched', { flag: 'wx' });
  writeFileSync(compileRoot, 'untouched', { flag: 'wx' });
  const hostile = {
    ...process.env,
    GIT_DIR: '/private/tmp/foreign',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    NODE_OPTIONS: '--require=/private/tmp/injected.cjs',
    NODE_PATH: '/private/tmp/modules',
    VSCODE_IPC_HOOK: '/private/tmp/foreign.sock',
    VSCODE_PORTABLE: '/private/tmp/foreign-portable',
    ELECTRON_RUN_AS_NODE: '1',
    VSCODE_NODE_COMPILE_CACHE_MEASUREMENTS: measurements,
    VSCODE_GENERATE_NODE_COMPILE_CACHE: '1',
    VSCODE_NODE_COMPILE_CACHE_ROOT: compileRoot,
    VSCODE_NODE_COMPILE_CACHE_KIND: 'main',
    vscode_node_compile_cache_measurements: '/private/tmp/case-variant',
    git_config_global: '/private/tmp/foreign.gitconfig',
    DEVLOOM_SECRET_CANARY: 'synthetic-secret-never-log',
  };
  const original = { ...hostile };
  const env = isolatedEnvironment('/private/tmp/session', '/private/tmp/h-g', hostile, {
    home: '/private/tmp/h-g/home',
    xdg: '/private/tmp/h-g/xdg',
  });
  assert.equal(env.VSCODE_DEV, '1');
  assert.equal(env.VSCODE_CLI, '1');
  assert.equal(env.DEVLOOM_APP_ROOT, process.cwd());
  assert.equal(env.HOME, '/private/tmp/h-g/home');
  assert.equal(env.XDG_CONFIG_HOME, '/private/tmp/h-g/xdg');
  assert.equal(Object.hasOwn(env, 'GIT_CONFIG_GLOBAL'), false);
  assert.equal(Object.hasOwn(env, 'GIT_CONFIG_SYSTEM'), false);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.ok(env.PATH.startsWith('/opt/homebrew/bin:'));
  for (const key of [
    'GIT_DIR',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'NODE_OPTIONS',
    'NODE_PATH',
    'VSCODE_IPC_HOOK',
    'VSCODE_PORTABLE',
    'ELECTRON_RUN_AS_NODE',
    'VSCODE_NODE_COMPILE_CACHE_MEASUREMENTS',
    'VSCODE_GENERATE_NODE_COMPILE_CACHE',
    'VSCODE_NODE_COMPILE_CACHE_ROOT',
    'VSCODE_NODE_COMPILE_CACHE_KIND',
    'vscode_node_compile_cache_measurements',
    'git_config_global',
    'DEVLOOM_SECRET_CANARY',
  ]) {
    if (key === 'DEVLOOM_SECRET_CANARY') continue;
    assert.equal(Object.hasOwn(env, key), false, `${key} was inherited`);
  }
  assert.deepEqual(hostile, original);
  assert.equal(readFileSync(measurements, 'utf8'), 'untouched');
  assert.equal(readFileSync(compileRoot, 'utf8'), 'untouched');
  assert.equal(env.DEVLOOM_SECRET_CANARY, 'synthetic-secret-never-log');
  assert.ok(
    Object.keys(env)
      .filter((key) => key.startsWith('GIT_'))
      .every((key) => ['GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT'].includes(key)),
  );
});

test('synthetic native argv binds distinct owned user, extension and shared storage paths', () => {
  const fixture = makeOwnerFixture(randomUUID());
  let configuration;
  startOwnedHost({
    runtime: { executable: '/fixed/electron', cwd: '/fixed/source' },
    fixture,
    evidence: '/private/tmp/evidence',
    env: {},
    launch: (options) => {
      configuration = options;
      return options;
    },
  });
  assert.equal(configuration.command, '/fixed/electron');
  assert.deepEqual(configuration.args.slice(0, 2), ['.', fixture.paths.w]);
  for (const name of ['u', 'e', 'a']) {
    assert.equal(
      (
        configuration.args.find((arg) =>
          arg.startsWith(
            `--${name === 'u' ? 'user-data-dir' : name === 'e' ? 'extensions-dir' : 'shared-data-dir'}=`,
          ),
        ) ?? ''
      )
        .split('=')
        .slice(1)
        .join('='),
      fixture.paths[name],
    );
  }
  assert.equal(new Set(['u', 'e', 'a', 'w'].map((name) => fixture.paths[name])).size, 4);
  assert.ok(fixture.paths.u.includes(fixture.nonce));
  assert.ok(fixture.identities.every((identity) => identity.mode === 0o700));
  assert.notEqual(fixture.paths.home, fixture.paths.xdg);
  assert.equal(fixture.paths.home, join(fixture.paths.g, 'home'));
  assert.equal(fixture.paths.xdg, join(fixture.paths.g, 'xdg'));
  assert.deepEqual(readdirSync(fixture.paths.home), []);
  assert.deepEqual(readdirSync(fixture.paths.xdg), []);
  assert.equal(removeFixture(fixture).disposition, 'removed');
});

test('synthetic partial allocation rollback removes only captured empty directories', () => {
  let failure;
  assert.throws(
    () =>
      makeOwnerFixture(randomUUID(), {
        afterDirectory(name) {
          if (name === 'home') throw Object.assign(new Error('injected'), { code: 'EIO' });
        },
      }),
    (error) => {
      failure = error;
      return error.code === 'EIO';
    },
  );
  assert.equal(failure.fixtureRoot.startsWith(realpathSync('/tmp')), true);
  assert.deepEqual(failure.leftovers, []);
  assert.equal(existsSync(failure.fixtureRoot), false);
});

test('synthetic partial allocation preserves a late sentinel when nonrecursive rmdir fails', () => {
  let failure;
  assert.throws(
    () =>
      makeOwnerFixture(randomUUID(), {
        afterDirectory(name) {
          if (name === 'home') throw Object.assign(new Error('injected'), { code: 'EIO' });
        },
        beforeRollbackRemove(operation, path) {
          if (operation === 'rmdir' && path.endsWith('/g/home'))
            writeFileSync(join(path, 'late-sentinel'), 'preserve', { flag: 'wx', mode: 0o600 });
        },
      }),
    (error) => {
      failure = error;
      return error.code === 'EIO';
    },
  );
  const sentinel = join(failure.fixtureRoot, 'g/home/late-sentinel');
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve');
  assert.ok(failure.leftovers.includes(join(failure.fixtureRoot, 'g/home')));
  rmSync(failure.fixtureRoot, { recursive: true, force: true });
});

test('synthetic same-UID check-use replacement is characterized inside disposable fixture only', () => {
  let failure;
  let moved;
  assert.throws(
    () =>
      makeOwnerFixture(randomUUID(), {
        afterDirectory(name) {
          if (name === 'home') throw Object.assign(new Error('injected'), { code: 'EIO' });
        },
        beforeRollbackRemove(operation, path) {
          if (operation !== 'rmdir' || !path.endsWith('/g/home')) return;
          moved = `${path}-captured`;
          renameSync(path, moved);
          mkdirSync(path, { mode: 0o700 });
        },
      }),
    (error) => {
      failure = error;
      return error.code === 'EIO';
    },
  );
  assert.equal(existsSync(join(failure.fixtureRoot, 'g/home')), false);
  assert.equal(existsSync(moved), true);
  assert.ok(failure.leftovers.includes(failure.fixtureRoot));
  rmSync(failure.fixtureRoot, { recursive: true, force: true });
});

test('synthetic completed fixture cleanup reports an I/O failure and preserves observed paths', () => {
  const fixture = makeOwnerFixture(randomUUID());
  const result = removeFixture(fixture, null, {
    removeTree() {
      throw Object.assign(new Error('injected'), { code: 'EIO' });
    },
  });
  assert.equal(result.disposition, 'cleanup-failed');
  assert.equal(result.code, 'EIO');
  assert.ok(result.paths.includes(fixture.fixtureRoot));
  assert.equal(existsSync(fixture.fixtureRoot), true);
  rmSync(fixture.fixtureRoot, { recursive: true, force: true });
});

test('synthetic partial rollback reports cleanup EIO separately and inventories exact survivors', () => {
  let failure;
  assert.throws(
    () =>
      makeOwnerFixture(randomUUID(), {
        afterDirectory(name) {
          if (name === 'xdg') throw Object.assign(new Error('primary'), { code: 'ENOSPC' });
        },
        beforeRollbackRemove(operation, path) {
          if (operation === 'rmdir' && path.endsWith('/g/xdg'))
            throw Object.assign(new Error('rollback'), { code: 'EIO' });
        },
      }),
    (error) => {
      failure = error;
      return error.code === 'ENOSPC';
    },
  );
  assert.deepEqual(failure.cleanupError, {
    stage: 'partial-fixture-rollback',
    code: 'EIO',
    paths: failure.leftovers,
  });
  assert.ok(failure.leftovers.includes(join(failure.fixtureRoot, 'g/xdg')));
  assert.ok(!failure.leftovers.includes(join(failure.fixtureRoot, 'g/home')));
  assert.ok(failure.leftovers.includes(join(failure.fixtureRoot, 'g')));
  rmSync(failure.fixtureRoot, { recursive: true, force: true });
});

test('synthetic remainder inventory stops at replaced directory boundaries', (t) => {
  const scratch = evidence();
  const outside = join(scratch, 'outside');
  mkdirSync(outside, { mode: 0o700 });
  writeFileSync(join(outside, 'sentinel'), 'outside bytes', { flag: 'wx', mode: 0o600 });
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  let failure;
  assert.throws(
    () =>
      makeOwnerFixture(randomUUID(), {
        afterDirectory(name) {
          if (name === 'home') throw Object.assign(new Error('primary'), { code: 'ENOSPC' });
        },
        beforeRollbackRemove(operation, path) {
          if (operation !== 'rmdir' || !path.endsWith('/g/home')) return;
          renameSync(path, `${path}-captured`);
          mkdirSync(path, { mode: 0o700 });
          writeFileSync(join(path, 'sentinel'), 'replacement bytes', { flag: 'wx', mode: 0o600 });
        },
      }),
    (error) => {
      failure = error;
      return error.code === 'ENOSPC';
    },
  );
  const replacement = join(failure.fixtureRoot, 'g/home');
  assert.ok(failure.leftovers.includes(replacement));
  assert.ok(failure.leftovers.includes(`UNKNOWN:${replacement}:IDENTITY_CHANGED`));
  assert.ok(!failure.leftovers.includes(join(replacement, 'sentinel')));
  assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'outside bytes');
  rmSync(failure.fixtureRoot, { recursive: true, force: true });
});

test('actual runner isolates first Git call and native-child routing under hostile parent config', async (t) => {
  if (process.env.DEVLOOM_RUNNER_PROCESS_QA !== '1')
    return t.skip('Run after pinned native artifacts are built');
  const qa = evidence();
  const scratch = join(qa, 'scratch');
  mkdirSync(scratch, { mode: 0o700 });
  for (const name of ['home', 'xdg', 'bin', 'compile-root'])
    mkdirSync(join(scratch, name), { mode: 0o700 });
  mkdirSync(join(scratch, 'xdg/git'), { mode: 0o700 });
  writeFileSync(join(scratch, 'home/.gitconfig'), '[devloom]\n marker=ambient-home\n');
  writeFileSync(join(scratch, 'xdg/git/config'), '[devloom]\n marker=ambient-xdg\n');
  writeFileSync(join(scratch, 'global.gitconfig'), '[devloom]\n marker=forbidden-global\n');
  writeFileSync(join(scratch, 'system.gitconfig'), '[devloom]\n marker=forbidden-system\n');
  writeFileSync(join(scratch, 'measurements'), 'measurement-sentinel');
  writeFileSync(join(scratch, 'compile-root/sentinel'), 'compile-sentinel');
  writeFileSync(join(scratch, 'foreign.index'), 'foreign-index-sentinel');
  const rogue = join(scratch, 'bin/git');
  writeFileSync(rogue, `#!/bin/sh\nprintf called > ${join(scratch, 'rogue-called')}\nexit 97\n`, {
    mode: 0o700,
  });
  chmodSync(rogue, 0o700);
  const foreignRepository = join(scratch, 'foreign.git');
  execFileSync('/opt/homebrew/bin/git', ['init', '--bare', foreignRepository], { stdio: 'ignore' });
  const inputs = scratchInventory(scratch);
  const hostile = {
    ...process.env,
    HOME: join(scratch, 'home'),
    XDG_CONFIG_HOME: join(scratch, 'xdg'),
    GIT_CONFIG_GLOBAL: join(scratch, 'global.gitconfig'),
    GIT_CONFIG_SYSTEM: join(scratch, 'system.gitconfig'),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: join(scratch, 'bin'),
    GIT_DIR: foreignRepository,
    GIT_INDEX_FILE: join(scratch, 'foreign.index'),
    NODE_OPTIONS: '--require=/private/tmp/foreign-injection.cjs',
    VSCODE_IPC_HOOK: '/private/tmp/foreign.sock',
    VSCODE_PORTABLE: '/private/tmp/foreign-portable',
    ELECTRON_RUN_AS_NODE: '1',
    VSCODE_NODE_COMPILE_CACHE_MEASUREMENTS: join(scratch, 'measurements'),
    VSCODE_GENERATE_NODE_COMPILE_CACHE: '1',
    VSCODE_NODE_COMPILE_CACHE_ROOT: join(scratch, 'compile-root'),
    VSCODE_NODE_COMPILE_CACHE_KIND: 'qa',
    vscode_node_compile_cache_measurements: join(scratch, 'mixed-case'),
    PATH: `${join(scratch, 'bin')}:/Users/bipo/.codex/worktrees/devloom-extension-host/IDE/.tools/node-v24.22.1-darwin-arm64/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    DEVLOOM_SECRET_CANARY: 'synthetic-secret-never-log',
  };
  const original = { ...hostile };
  const observations = { trace: [], fixture: null, sourceGit: [], child: null };
  const childSnapshot = join(qa, 'native-child-environment.json');
  const childScript = `const fs=require('node:fs');const cp=require('node:child_process');const names=['GIT_DIR','GIT_INDEX_FILE','GIT_CONFIG_GLOBAL','GIT_CONFIG_SYSTEM','GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0','NODE_OPTIONS','VSCODE_IPC_HOOK','VSCODE_PORTABLE','ELECTRON_RUN_AS_NODE','VSCODE_NODE_COMPILE_CACHE_MEASUREMENTS','VSCODE_GENERATE_NODE_COMPILE_CACHE','VSCODE_NODE_COMPILE_CACHE_ROOT','VSCODE_NODE_COMPILE_CACHE_KIND','vscode_node_compile_cache_measurements','DEVLOOM_SECRET_CANARY'];const query=(scope)=>{try{cp.execFileSync('/opt/homebrew/bin/git',['config',scope,'--get','devloom.marker'],{env:process.env,stdio:'pipe'});return 0}catch(e){return e.status}};const snapshot={home:process.env.HOME,xdg:process.env.XDG_CONFIG_HOME,homeMode:fs.statSync(process.env.HOME).mode&511,xdgMode:fs.statSync(process.env.XDG_CONFIG_HOME).mode&511,homeContents:fs.readdirSync(process.env.HOME),xdgContents:fs.readdirSync(process.env.XDG_CONFIG_HOME),present:Object.fromEntries(names.map(k=>[k,Object.hasOwn(process.env,k)])),gitGlobalLookup:query('--global'),gitSystemLookup:query('--system'),gitConfigNoSystem:process.env.GIT_CONFIG_NOSYSTEM,gitPrompt:process.env.GIT_TERMINAL_PROMPT,path:process.env.PATH};fs.writeFileSync(process.argv[2],JSON.stringify(snapshot),{flag:'wx',mode:384});fs.writeFileSync(require('node:path').join(process.argv[1],'result.json'),JSON.stringify({status:'pass'}),{flag:'wx',mode:384});`;
  const outcome = await runExtensionHost({
    evidenceParent: process.env.DEVLOOM_EVIDENCE_DIR,
    parentEnvironment: hostile,
    trace(event) {
      observations.trace.push(event);
    },
    observeFixture(fixture) {
      const stat = (path) => {
        const value = lstatSync(path);
        return { uid: value.uid, mode: value.mode & 0o777, dev: value.dev, ino: value.ino };
      };
      observations.fixture = {
        root: fixture.fixtureRoot,
        paths: fixture.paths,
        identities: fixture.identities.map(({ path, uid, mode, dev, ino }) => ({
          path,
          uid,
          mode,
          dev,
          ino,
        })),
        home: stat(fixture.paths.home),
        xdg: stat(fixture.paths.xdg),
        homeContents: readdirSync(fixture.paths.home),
        xdgContents: readdirSync(fixture.paths.xdg),
        marker: stat(fixture.markerPath),
      };
    },
    observeSourceGit({ executable, args, cwd, env }) {
      observations.sourceGit.push({
        executable,
        args,
        cwd,
        home: env.HOME,
        xdg: env.XDG_CONFIG_HOME,
        forbidden: [
          'GIT_CONFIG_GLOBAL',
          'GIT_CONFIG_SYSTEM',
          'GIT_DIR',
          'GIT_INDEX_FILE',
          'GIT_CONFIG_COUNT',
          'GIT_CONFIG_KEY_0',
          'NODE_OPTIONS',
          'VSCODE_IPC_HOOK',
          'VSCODE_PORTABLE',
          'ELECTRON_RUN_AS_NODE',
          'VSCODE_NODE_COMPILE_CACHE_MEASUREMENTS',
          'VSCODE_GENERATE_NODE_COMPILE_CACHE',
          'VSCODE_NODE_COMPILE_CACHE_ROOT',
          'VSCODE_NODE_COMPILE_CACHE_KIND',
          'vscode_node_compile_cache_measurements',
        ].filter((key) => Object.hasOwn(env, key)),
        gitConfigNoSystem: env.GIT_CONFIG_NOSYSTEM,
        gitPrompt: env.GIT_TERMINAL_PROMPT,
        path: env.PATH,
      });
    },
    timeoutMs: 100,
    launch(configuration) {
      const childEnv = configuration.env;
      observations.child = {
        home: childEnv.HOME,
        xdg: childEnv.XDG_CONFIG_HOME,
        forbidden: [
          'GIT_CONFIG_GLOBAL',
          'GIT_CONFIG_SYSTEM',
          'GIT_DIR',
          'GIT_INDEX_FILE',
          'GIT_CONFIG_COUNT',
          'GIT_CONFIG_KEY_0',
          'NODE_OPTIONS',
          'VSCODE_IPC_HOOK',
          'VSCODE_PORTABLE',
          'ELECTRON_RUN_AS_NODE',
          'VSCODE_NODE_COMPILE_CACHE_MEASUREMENTS',
          'VSCODE_GENERATE_NODE_COMPILE_CACHE',
          'VSCODE_NODE_COMPILE_CACHE_ROOT',
          'VSCODE_NODE_COMPILE_CACHE_KIND',
          'vscode_node_compile_cache_measurements',
        ].filter((key) => Object.hasOwn(childEnv, key)),
        path: childEnv.PATH,
      };
      return launchOwned({
        ...configuration,
        command: process.execPath,
        args: [
          '-e',
          childScript,
          '--',
          configuration.evidence,
          childSnapshot,
          `--user-data-dir=${configuration.profile}`,
        ],
        cwd: configuration.fixtureRoot,
      });
    },
  });
  const child = JSON.parse(readFileSync(childSnapshot, 'utf8'));
  const runner = JSON.parse(readFileSync(join(outcome.evidence, 'runner-result.json'), 'utf8'));
  const nativeResult = JSON.parse(readFileSync(outcome.resultPath, 'utf8'));
  const after = scratchInventory(scratch);
  observations.outcome = {
    runnerStatus: runner.status,
    sourceHead: runner.sourceHead,
    workspacePath: runner.workspacePath,
    resultStatus: nativeResult.status,
    closed: runner.confirmedClosed,
    cleanup: runner.cleanup,
  };
  assert.equal(runner.status, 'pass');
  assert.equal(runner.sourcePreflight, 'passed');
  assert.equal(observations.sourceGit[0].executable, '/opt/homebrew/bin/git');
  assert.ok(observations.sourceGit[0].args.includes('--version'));
  assert.ok(observations.sourceGit[0].cwd.endsWith('/vendor/code-oss'));
  assert.deepEqual(observations.sourceGit[0].forbidden, []);
  assert.equal(observations.sourceGit[0].home, observations.fixture.paths.home);
  assert.equal(observations.sourceGit[0].xdg, observations.fixture.paths.xdg);
  assert.equal(observations.sourceGit[0].gitConfigNoSystem, '1');
  assert.equal(observations.sourceGit[0].gitPrompt, '0');
  assert.ok(observations.sourceGit[0].path.startsWith('/opt/homebrew/bin:'));
  assert.deepEqual(observations.trace.slice(0, 4), [
    'before-source-preflight',
    'source-preflight-complete',
    'fixture-git',
    'native-launch',
  ]);
  assert.ok(
    observations.fixture.identities.every(
      (item) => item.uid === process.getuid() && item.mode === 0o700,
    ),
  );
  assert.equal(observations.fixture.marker.mode, 0o600);
  assert.deepEqual(observations.fixture.homeContents, []);
  assert.deepEqual(observations.fixture.xdgContents, []);
  assert.equal(child.home, observations.fixture.paths.home);
  assert.equal(child.xdg, observations.fixture.paths.xdg);
  assert.equal(child.homeMode, 0o700);
  assert.equal(child.xdgMode, 0o700);
  assert.deepEqual(child.homeContents, []);
  assert.deepEqual(child.xdgContents, []);
  assert.equal(child.gitGlobalLookup, 1);
  assert.equal(child.gitSystemLookup, 1);
  assert.equal(child.gitConfigNoSystem, '1');
  assert.equal(child.gitPrompt, '0');
  assert.deepEqual(observations.child.forbidden, []);
  assert.deepEqual(after, inputs);
  assert.deepEqual(hostile, original);
  assert.equal(existsSync(join(scratch, 'rogue-called')), false);
  const evidenceFiles = [...readTreeFiles(qa), ...readTreeFiles(outcome.evidence)];
  const canaryValueAbsent = !evidenceFiles.some((content) =>
    content.includes('synthetic-secret-never-log'),
  );
  const report = {
    observations,
    child,
    scratchInventoryBefore: inputs,
    scratchInventoryAfter: after,
    secretCanaryPresentOnlyAsBoolean: child.present.DEVLOOM_SECRET_CANARY,
    secretCanaryValueAbsent: canaryValueAbsent,
  };
  writeFileSync(join(qa, 'qa-result.json'), JSON.stringify(report, null, 2), {
    flag: 'wx',
    mode: 0o600,
  });
  const allEvidence = [...readTreeFiles(qa), ...readTreeFiles(outcome.evidence)];
  assert.equal(
    allEvidence.some((content) => content.includes('synthetic-secret-never-log')),
    false,
  );
});

test('actual runner subprocess exits unsignaled with an unconfirmed child after result write failure', async (t) => {
  if (process.env.DEVLOOM_RUNNER_PROCESS_QA !== '1')
    return t.skip('Run after pinned native artifacts are built');
  for (const mode of ['EIO', 'EEXIST', 'IDENTITY']) {
    const scratch = evidence();
    const handshake = join(scratch, `runner-${mode}.json`);
    const acknowledgment = join(scratch, `runner-${mode}.ready`);
    const observationsPath = join(scratch, `runner-${mode}-observations.json`);
    const observations = { mode, startedAt: new Date().toISOString() };
    let identity;
    let fixtureIdentity;
    let fixtureRoot;
    let profile;
    let outer;
    let runnerCompleted = false;
    t.after(async () => {
      if (outer && !runnerCompleted) {
        if (outer.exitCode === null && outer.signalCode === null) {
          outer.kill('SIGTERM');
          await new Promise((resolve) => outer.once('close', resolve));
        }
      }
      if (identity) {
        const current = probeProcess(identity.pid);
        assert.equal(current.uid, identity.uid);
        assert.equal(current.startIdentity, identity.startIdentity);
        assert.equal(current.detachedPgid, identity.detachedPgid);
        assert.ok(current.args.includes(`--user-data-dir=${profile}`));
        const members = groupMembers(identity.detachedPgid);
        assert.ok(members.length > 0);
        assert.ok(members.every((member) => member.uid === identity.uid));
        observations.cleanupProof = {
          at: new Date().toISOString(),
          uid: current.uid,
          pid: current.pid,
          startIdentity: current.startIdentity,
          detachedPgid: current.detachedPgid,
          profileArgumentMatched: current.args.includes(`--user-data-dir=${profile}`),
          members: members.map(({ pid, uid, detachedPgid }) => ({ pid, uid, detachedPgid })),
        };
        process.kill(-identity.detachedPgid, 'SIGTERM');
        await waitFor(() => groupMembers(identity.detachedPgid).length === 0, 5000);
        observations.harnessCleanup = {
          at: new Date().toISOString(),
          signal: 'SIGTERM',
          membersAfter: groupMembers(identity.detachedPgid).length,
        };
      }
      if (fixtureRoot) {
        const fixtureNow = lstatSync(fixtureRoot);
        assert.equal(fixtureNow.isDirectory(), true);
        assert.equal(fixtureNow.isSymbolicLink(), false);
        assert.equal(fixtureNow.dev, fixtureIdentity.dev);
        assert.equal(fixtureNow.ino, fixtureIdentity.ino);
        assert.equal(fixtureNow.uid, fixtureIdentity.uid);
        assert.equal(fixtureNow.mode & 0o777, fixtureIdentity.mode);
        assert.equal(realpathSync(fixtureRoot), fixtureIdentity.canonical);
        observations.fixtureBeforeHarnessCleanup = {
          exists: true,
          ownerMarkerPresent: readdirSync(fixtureRoot).some((name) => name.startsWith('.owner-')),
        };
        rmSync(fixtureRoot, { recursive: true, force: true });
        observations.fixtureRemovedAfterOwnershipCheck = !existsSync(fixtureRoot);
      }
      writeFileSync(
        join(scratch, `runner-${mode}-cleanup.json`),
        JSON.stringify(observations, null, 2),
        {
          flag: 'wx',
          mode: 0o600,
        },
      );
    });
    const moduleUrl = new URL('../scripts/runExtensionHost.mjs', import.meta.url).href;
    const source = `
      import { runExtensionHost } from ${JSON.stringify(moduleUrl)};
      import { launchOwned, probeProcess } from ${JSON.stringify(new URL('../scripts/localGitSession.mjs', import.meta.url).href)};
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      try {
        await runExtensionHost({
          evidenceParent: process.env.DEVLOOM_EVIDENCE_DIR,
          timeoutMs: 100,
          probes: ${JSON.stringify(mode)} === 'IDENTITY' ? { initialProbe() { throw Object.assign(new Error('identity'), { code: 'EACCES' }); } } : {},
          launch(configuration) {
            return launchOwned({
              ...configuration,
              command: process.execPath,
              args: ['-e', 'const fs=require("node:fs");const ack=process.argv[2];const wait=setInterval(()=>{if(fs.existsSync(ack)){clearInterval(wait);setInterval(()=>{},1000)}},10)', '--', '--user-data-dir=' + configuration.profile, ${JSON.stringify(acknowledgment)}],
              authorizationProbe: () => null,
              onChild(child) {
                writeFileSync(${JSON.stringify(handshake)}, JSON.stringify({ pid: child.pid, evidence: configuration.evidence, fixtureRoot: configuration.fixtureRoot, profile: configuration.profile, readyAt: Date.now(), timeoutMs: configuration.timeoutMs }), { flag: 'wx', mode: 0o600 });
              },
            });
          },
          writeRunnerResult(path, bytes, options) {
            if (${JSON.stringify(mode)} === 'EIO') throw Object.assign(new Error('injected'), { code: 'EIO' });
            if (${JSON.stringify(mode)} === 'EEXIST') {
              writeFileSync(path, 'preexisting sentinel', { flag: 'wx', mode: 0o600 });
              writeFileSync(path, bytes, options);
            } else writeFileSync(path, bytes, options);
          },
        });
      } catch (error) {
        const summaryFailure = error.runnerResultFailure ? '; runner-result write failed (' + error.runnerResultFailure + ')' : '';
        process.stderr.write('Extension host failed (' + (error.code || 'RUNNER_FAILED') + ')' + summaryFailure + (error.childMayRemain ? '; child may remain' : '') + '\\n');
        process.exitCode = 1;
      }
    `;
    outer = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd: process.cwd(),
      env: { ...process.env, DEVLOOM_EVIDENCE_DIR: scratch },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    outer.stderr.setEncoding('utf8');
    outer.stderr.on('data', (chunk) => (stderr += chunk));
    const outerClosed = new Promise((resolve) =>
      outer.once('close', (code, signal) => resolve({ code, signal })),
    );
    await waitFor(
      () => existsSync(handshake) || outer.exitCode !== null || outer.signalCode !== null,
      10000,
    );
    assert.equal(
      existsSync(handshake),
      true,
      `runner never published readiness (${mode}): ${stderr}`,
    );
    const owner = JSON.parse(readFileSync(handshake, 'utf8'));
    observations.handshake = owner;
    const candidate = probeProcess(owner.pid);
    const harnessIdentity = probeProcess(process.pid);
    const runnerIdentity = probeProcess(outer.pid);
    const launchMarkers = readdirSync(owner.fixtureRoot).filter((name) =>
      name.startsWith('.launch-'),
    );
    const marker =
      launchMarkers.length === 1
        ? JSON.parse(readFileSync(join(owner.fixtureRoot, launchMarkers[0]), 'utf8'))
        : null;
    const candidateMembers = groupMembers(candidate.detachedPgid);
    const identityOnly = mode === 'IDENTITY';
    const candidateValid =
      candidate.uid === process.getuid() &&
      candidate.pid === owner.pid &&
      candidate.detachedPgid === owner.pid &&
      candidate.detachedPgid !== harnessIdentity.detachedPgid &&
      candidate.detachedPgid !== runnerIdentity.detachedPgid &&
      candidate.args.includes(`--user-data-dir=${owner.profile}`) &&
      owner.profile === join(owner.fixtureRoot, 'u') &&
      /^\/private\/tmp\/h-[a-f0-9]{32}$/.test(owner.fixtureRoot) &&
      realpathSync(owner.fixtureRoot) === owner.fixtureRoot &&
      (identityOnly ||
        (marker?.pid === candidate.pid &&
          marker?.uid === candidate.uid &&
          marker?.startIdentity === candidate.startIdentity &&
          marker?.detachedPgid === candidate.detachedPgid &&
          marker?.canonicalFixtureRoot === owner.fixtureRoot &&
          marker?.canonicalProfile === owner.profile)) &&
      candidateMembers.some(
        (member) =>
          member.pid === candidate.pid &&
          member.uid === candidate.uid &&
          member.detachedPgid === candidate.detachedPgid,
      );
    assert.equal(candidateValid, true, 'child identity must be independently verified before use');
    identity = candidate;
    fixtureRoot = owner.fixtureRoot;
    profile = owner.profile;
    const fixtureStat = lstatSync(fixtureRoot);
    fixtureIdentity = {
      dev: fixtureStat.dev,
      ino: fixtureStat.ino,
      uid: fixtureStat.uid,
      mode: fixtureStat.mode & 0o777,
      canonical: realpathSync(fixtureRoot),
    };
    observations.capturedIdentity = {
      at: new Date().toISOString(),
      uid: candidate.uid,
      pid: candidate.pid,
      startIdentity: candidate.startIdentity,
      detachedPgid: candidate.detachedPgid,
      profileArgumentMatched: candidate.args.includes(`--user-data-dir=${profile}`),
      independentlyVerified: candidateValid,
      groupMembers: candidateMembers.map(({ pid, uid, detachedPgid }) => ({
        pid,
        uid,
        detachedPgid,
      })),
    };
    assert.ok(Date.now() < owner.readyAt + owner.timeoutMs);
    writeFileSync(acknowledgment, 'identity captured', { flag: 'wx', mode: 0o600 });
    let watchdog;
    const closed = await Promise.race([
      outerClosed,
      new Promise((resolve) => {
        watchdog = setTimeout(() => resolve({ timeout: true }), 10000);
      }),
    ]);
    clearTimeout(watchdog);
    runnerCompleted = closed.timeout === undefined;
    observations.runnerExit = {
      at: new Date().toISOString(),
      code: closed.code,
      signal: closed.signal,
    };
    assert.equal(closed.timeout, undefined, 'runner exceeded independent watchdog');
    assert.equal(closed.code, 1);
    assert.equal(closed.signal, null);
    const afterOuterExit = probeProcess(identity.pid);
    observations.childAfterRunnerExit = {
      at: new Date().toISOString(),
      alive: true,
      uid: afterOuterExit.uid,
      pid: afterOuterExit.pid,
      startIdentity: afterOuterExit.startIdentity,
      detachedPgid: afterOuterExit.detachedPgid,
      identityMatched:
        afterOuterExit.uid === identity.uid &&
        afterOuterExit.startIdentity === identity.startIdentity &&
        afterOuterExit.detachedPgid === identity.detachedPgid,
      groupSize: groupMembers(identity.detachedPgid).length,
    };
    assert.equal(afterOuterExit.uid, identity.uid);
    assert.equal(afterOuterExit.startIdentity, identity.startIdentity);
    assert.equal(afterOuterExit.detachedPgid, identity.detachedPgid);
    assert.ok(afterOuterExit.args.includes(profile));
    assert.ok(groupMembers(identity.detachedPgid).some((member) => member.pid === identity.pid));
    assert.ok(stderr.includes('child may remain'));
    if (identityOnly) {
      const summary = JSON.parse(readFileSync(join(owner.evidence, 'runner-result.json'), 'utf8'));
      assert.equal(summary.status, 'fail');
      assert.equal(summary.ownership, 'ambiguous');
      assert.equal(summary.confirmedClosed, false);
      assert.equal(summary.childMayRemain, true);
      assert.equal(summary.cleanup.disposition, 'preserved');
      assert.equal(summary.cleanup.paths.includes(owner.fixtureRoot), true);
    } else assert.ok(stderr.includes(`runner-result write failed (${mode})`));
    observations.stderrClassification = {
      writeFailureCodePresent:
        !identityOnly && stderr.includes(`runner-result write failed (${mode})`),
      possibleChildWarningPresent: stderr.includes('child may remain'),
      rawContentsStored: false,
    };
    const runnerResultPath = join(owner.evidence, 'runner-result.json');
    assert.equal(existsSync(runnerResultPath), mode !== 'EIO');
    observations.runnerResultFile = {
      exists: existsSync(runnerResultPath),
      expected:
        mode === 'EIO'
          ? 'missing-after-injected-write-error'
          : mode === 'EEXIST'
            ? 'preexisting-sentinel'
            : 'writable-failure-summary',
      sentinelPreserved:
        mode === 'EEXIST' && readFileSync(runnerResultPath, 'utf8') === 'preexisting sentinel',
      status: identityOnly ? JSON.parse(readFileSync(runnerResultPath, 'utf8')).status : null,
    };
    if (mode === 'EEXIST')
      assert.equal(readFileSync(runnerResultPath, 'utf8'), 'preexisting sentinel');
    assert.equal(existsSync(fixtureRoot), true);
    assert.ok(readdirSync(fixtureRoot).some((name) => name.startsWith('.owner-')));
    writeFileSync(observationsPath, JSON.stringify(observations, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
  }
});

test('synthetic evidence path refusals happen before a session can be created', async (t) => {
  const scratch = evidence();
  const link = join(scratch, 'source-link');
  symlinkSync(process.cwd(), link);
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  await assert.rejects(
    runExtensionHost({ evidenceParent: 'relative-evidence' }),
    /INVALID_EVIDENCE_PARENT/,
  );
  await assert.rejects(
    runExtensionHost({ evidenceParent: process.cwd() }),
    /INTERNAL_EVIDENCE_PARENT/,
  );
  await assert.rejects(runExtensionHost({ evidenceParent: link }), /INTERNAL_EVIDENCE_PARENT/);
  assert.deepEqual(readdirSync(scratch), ['source-link']);
});

test('synthetic portable collision fails before fixture or source work', async (t) => {
  const scratch = evidence();
  const portable = join(scratch, 'portable-data');
  mkdirSync(portable, { mode: 0o700 });
  writeFileSync(join(portable, 'sentinel'), 'preserve', { flag: 'wx', mode: 0o600 });
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  await assert.rejects(
    runExtensionHost({ evidenceParent: scratch, runtimeFactory: () => ({ portable }) }),
    (error) => {
      assert.equal(error.code, 'PORTABLE_DATA_EXISTS');
      return true;
    },
  );
  const sessions = readdirSync(scratch).filter((name) => name.startsWith('session-'));
  assert.equal(sessions.length, 1);
  const summary = JSON.parse(
    readFileSync(join(scratch, sessions[0], 'runner-result.json'), 'utf8'),
  );
  assert.equal(summary.stage, 'portable-check');
  assert.equal(summary.sourcePreflight, 'not-run');
  assert.equal(summary.cleanup.disposition, 'not-allocated');
  assert.deepEqual(readdirSync(portable), ['sentinel']);
});

test('synthetic reobservation realpath failure is recorded as an unknown boundary', () => {
  const fixture = makeOwnerFixture(randomUUID());
  const host = { state: { pid: 1, finalized: true, ownership: 'ambiguous', cleanup: {} } };
  const result = removeFixture(fixture, host, {
    realpath(path) {
      if (path === fixture.paths.g) throw Object.assign(new Error('injected'), { code: 'EIO' });
      return realpathSync(path);
    },
  });
  assert.equal(result.disposition, 'preserved');
  assert.ok(result.paths.includes(`UNKNOWN:${fixture.paths.g}:EIO`));
  assert.equal(existsSync(fixture.paths.g), true);
  rmSync(fixture.fixtureRoot, { recursive: true, force: true });
});

test('synthetic owner marker mode change refuses recursive fixture cleanup', () => {
  const fixture = makeOwnerFixture(randomUUID());
  chmodSync(fixture.markerPath, 0o644);
  const result = removeFixture(fixture);
  assert.equal(result.disposition, 'preserved');
  assert.ok(result.paths.includes(fixture.fixtureRoot));
  assert.equal(readFileSync(fixture.markerPath, 'utf8'), JSON.stringify(fixture.marker));
  rmSync(fixture.fixtureRoot, { recursive: true, force: true });
});

test('synthetic fixture refuses precheck sentinels in captured home, user data and Git runtime', () => {
  for (const target of ['home', 'user', 'git-runtime']) {
    let failure;
    assert.throws(
      () =>
        makeOwnerFixture(randomUUID(), {
          afterDirectory(name, path) {
            if (name !== 'home') return;
            const root = join(path, '..', '..');
            const sentinel =
              target === 'home'
                ? join(path, 'sentinel')
                : target === 'user'
                  ? join(root, 'u', 'sentinel')
                  : join(root, 'g', 'unexpected', 'sentinel');
            mkdirSync(join(sentinel, '..'), { recursive: true, mode: 0o700 });
            writeFileSync(sentinel, `preserve-${target}`, { flag: 'wx', mode: 0o600 });
            throw Object.assign(new Error('primary'), { code: 'ENOSPC' });
          },
        }),
      (error) => {
        failure = error;
        return error.code === 'ENOSPC';
      },
    );
    const sentinelPath =
      target === 'home'
        ? join(failure.fixtureRoot, 'g/home/sentinel')
        : target === 'user'
          ? join(failure.fixtureRoot, 'u/sentinel')
          : join(failure.fixtureRoot, 'g/unexpected/sentinel');
    assert.equal(readFileSync(sentinelPath, 'utf8'), `preserve-${target}`);
    assert.ok(
      failure.leftovers.includes(sentinelPath) ||
        (target === 'git-runtime' &&
          failure.leftovers.includes(join(failure.fixtureRoot, 'g/unexpected'))),
    );
    const rootIdentity = lstatSync(failure.fixtureRoot);
    writeQaEvidence('identity-refusal-sentinel', {
      target,
      primaryCode: failure.code,
      root: failure.fixtureRoot,
      rootIdentity: {
        uid: rootIdentity.uid,
        mode: rootIdentity.mode & 0o777,
        dev: rootIdentity.dev,
        ino: rootIdentity.ino,
      },
      sentinelPath,
      sentinelSha256: createHash('sha256').update(readFileSync(sentinelPath)).digest('hex'),
      sentinelPreserved: readFileSync(sentinelPath, 'utf8') === `preserve-${target}`,
      reportedBoundary: failure.leftovers.includes(sentinelPath) || target === 'git-runtime',
    });
    rmSync(failure.fixtureRoot, { recursive: true, force: true });
  }
});

test('synthetic uncaptured directory and partial owner marker fail closed', () => {
  let uncaptured;
  assert.throws(
    () =>
      makeOwnerFixture(randomUUID(), {
        afterDirectoryCreated(name, path) {
          if (name !== 'home') return;
          writeFileSync(join(path, 'sentinel'), 'uncaptured', { flag: 'wx', mode: 0o600 });
          throw Object.assign(new Error('primary'), { code: 'EIO' });
        },
      }),
    (error) => {
      uncaptured = error;
      return error.code === 'EIO';
    },
  );
  assert.ok(uncaptured.leftovers.includes(join(uncaptured.fixtureRoot, 'g/home')));
  assert.ok(
    uncaptured.leftovers.includes(
      `UNKNOWN:${join(uncaptured.fixtureRoot, 'g/home')}:IDENTITY_CHANGED`,
    ),
  );
  assert.equal(readFileSync(join(uncaptured.fixtureRoot, 'g/home/sentinel'), 'utf8'), 'uncaptured');
  writeQaEvidence('uncaptured-partial-fixture', {
    primaryCode: uncaptured.code,
    leftovers: uncaptured.leftovers,
    sentinelPreserved:
      readFileSync(join(uncaptured.fixtureRoot, 'g/home/sentinel'), 'utf8') === 'uncaptured',
    cleanupError: uncaptured.cleanupError,
  });
  rmSync(uncaptured.fixtureRoot, { recursive: true, force: true });

  let partial;
  assert.throws(
    () =>
      makeOwnerFixture(randomUUID(), {
        beforeMarkerWrite(path) {
          writeFileSync(path, '{partial', { flag: 'wx', mode: 0o600 });
        },
      }),
    (error) => {
      partial = error;
      return error.code === 'EEXIST';
    },
  );
  assert.ok(partial.leftovers.includes(partial.fixtureRoot));
  const partialMarker = readdirSync(partial.fixtureRoot).find((name) => name.startsWith('.owner-'));
  assert.ok(partialMarker);
  assert.equal(readFileSync(join(partial.fixtureRoot, partialMarker), 'utf8'), '{partial');
  assert.ok(partial.cleanupError);
  writeQaEvidence('partial-owner-marker', {
    primaryCode: partial.code,
    cleanupError: partial.cleanupError,
    fixtureRootPresent: existsSync(partial.fixtureRoot),
    markerBytes: readFileSync(join(partial.fixtureRoot, partialMarker), 'utf8'),
  });
  rmSync(partial.fixtureRoot, { recursive: true, force: true });
});

test('synthetic shared evidence helper preserves existing sessions', (t) => {
  const scratch = evidence();
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const first = createEvidenceDirectory(scratch);
  const second = createEvidenceDirectory(scratch);
  writeFileSync(join(first, 'sentinel'), 'first-existing-session', { flag: 'wx', mode: 0o600 });
  writeFileSync(join(second, 'sentinel'), 'second-existing-session', { flag: 'wx', mode: 0o600 });
  const third = createEvidenceDirectory(scratch);
  assert.notEqual(first, second);
  assert.notEqual(second, third);
  assert.equal(readFileSync(join(first, 'sentinel'), 'utf8'), 'first-existing-session');
  assert.equal(readFileSync(join(second, 'sentinel'), 'utf8'), 'second-existing-session');
  writeQaEvidence('helper-import-contract', {
    sessionPathsDistinct: new Set([first, second, third]).size === 3,
    firstSentinelSha256: createHash('sha256')
      .update(readFileSync(join(first, 'sentinel')))
      .digest('hex'),
    secondSentinelSha256: createHash('sha256')
      .update(readFileSync(join(second, 'sentinel')))
      .digest('hex'),
    existingSessionsPreserved: true,
    secretCanarySerialized: false,
  });
});

test('synthetic artifact preflight rejects missing, mismatched, symlinked and non-executable inputs', (t) => {
  const scratch = evidence();
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'root');
  const upstream = join(root, 'vendor/code-oss');
  const overlay = {
    nameShort: 'Devloom IDE',
    nameLong: 'Devloom IDE',
    applicationName: 'devloom',
    dataFolderName: '.devloom',
  };
  const source = { overlay };
  const files = [
    'out/cli.js',
    'out/vs/code/electron-main/main.js',
    'extensions/git/out/main.js',
  ].map((relative) => join(upstream, relative));
  const rootFiles = [
    join(root, 'dist/tests/extensionHost.js'),
    join(root, 'extensions/devloom-bootstrap/dist/extension.js'),
    join(root, 'crates/devloom-sidecar/target/debug/devloom-sidecar'),
  ];
  const runtimePath = join(upstream, 'electron/Electron');
  for (const path of [
    ...files,
    ...rootFiles,
    runtimePath,
    join(upstream, 'product.overrides.json'),
  ]) {
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(
      path,
      path === join(upstream, 'product.overrides.json')
        ? `${JSON.stringify(overlay, null, 2)}\n`
        : 'artifact',
      { flag: 'wx', mode: 0o700 },
    );
  }
  mkdirSync(join(upstream, '.build/electron'), { recursive: true, mode: 0o700 });
  chmodSync(runtimePath, 0o700);
  chmodSync(rootFiles[2], 0o700);
  const runtime = { executable: runtimePath };
  const roots = { root, upstream };
  assert.doesNotThrow(() => assertPreparedArtifacts(runtime, source, roots));
  const missing = files[0];
  rmSync(missing);
  assert.throws(() => assertPreparedArtifacts(runtime, source, roots), { code: 'ENOENT' });
  writeFileSync(missing, 'artifact', { flag: 'wx', mode: 0o700 });
  writeFileSync(join(upstream, 'product.overrides.json'), 'wrong overlay');
  assert.throws(() => assertPreparedArtifacts(runtime, source, roots), /OVERLAY_NOT_PUBLISHED/);
  writeFileSync(join(upstream, 'product.overrides.json'), `${JSON.stringify(overlay, null, 2)}\n`);
  chmodSync(runtimePath, 0o600);
  assert.throws(
    () => assertPreparedArtifacts(runtime, source, roots),
    /PREPARED_ARTIFACT_NOT_EXECUTABLE/,
  );
  chmodSync(runtimePath, 0o700);
  const external = join(scratch, 'outside-artifact');
  writeFileSync(external, 'outside', { flag: 'wx', mode: 0o700 });
  rmSync(join(upstream, 'product.overrides.json'));
  symlinkSync(external, join(upstream, 'product.overrides.json'));
  assert.throws(() => assertPreparedArtifacts(runtime, source, roots), /PREPARED_ARTIFACT_MISSING/);
  assert.equal(readFileSync(external, 'utf8'), 'outside');
});

test('synthetic short /tmp fixture canonicalization keeps both pinned IPC sockets below macOS limit', () => {
  const fixture = makeOwnerFixture(randomUUID());
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), 'vendor/code-oss/package.json'), 'utf8'),
  );
  const sockets = ['main', 'shared'].map((type) =>
    join(fixture.paths.u, `${manifest.version.slice(0, 4)}-${type.slice(0, 6)}.sock`),
  );
  assert.equal(fixture.fixtureRoot, realpathSync(join('/tmp', basename(fixture.fixtureRoot))));
  assert.ok(fixture.fixtureRoot.endsWith(`/h-${fixture.nonce}`));
  assert.ok(
    fixture.identities.every((identity) => identity.canonical === realpathSync(identity.path)),
  );
  if (process.platform === 'darwin') {
    assert.equal(realpathSync('/tmp'), '/private/tmp');
    assert.ok(sockets.every((socket) => Buffer.byteLength(socket, 'utf8') < 103));
    assert.doesNotThrow(() => checkSocketBounds(fixture.paths.u, manifest.version));
  }
  assert.equal(removeFixture(fixture).disposition, 'removed');
});

test('synthetic real owned Node exit confirms closure without signaling and leaves sentinel alive', async (t) => {
  const directory = evidence();
  const fixture = makeOwnerFixture(randomUUID());
  const sentinel = startSentinel(directory);
  t.after(async () => {
    await sentinel.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const host = launchSynthetic(fixture, directory, 'setTimeout(()=>process.exit(0),80)');
  const result = await host.completion;
  assert.equal(result.status, 'pass');
  assert.equal(result.cleanup.confirmedClosed, true);
  assert.deepEqual(result.terminationAttempts, []);
  assert.equal(removeFixture(fixture, host).disposition, 'removed');
  await sentinel.verify();
  writeQaEvidence('normal-close-no-signal', {
    status: result.status,
    confirmedClosed: result.cleanup.confirmedClosed,
    terminationAttempts: result.terminationAttempts,
    fixtureRemoved: !existsSync(fixture.fixtureRoot),
    independentSentinelAliveAndUnchanged: true,
  });
});

test('synthetic initial identity probe failure preserves fixture and never signals; harness proof is separate', async (t) => {
  const directory = evidence();
  const fixture = makeOwnerFixture(randomUUID());
  const sentinel = startSentinel(directory);
  let syntheticIdentity;
  t.after(async () => {
    await sentinel.stop();
    rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  });
  const host = startOwnedHost({
    runtime: { executable: process.execPath, cwd: fixture.fixtureRoot },
    fixture,
    evidence: directory,
    env: isolatedEnvironment(directory, fixture.paths.g),
    timeoutMs: 180,
    probes: {
      initialProbe: () => {
        throw new Error('SYNTHETIC_INITIAL_PROBE_FAILURE');
      },
    },
    launch: (configuration) => {
      const child = launchOwned({
        ...configuration,
        command: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)', '--', `--user-data-dir=${configuration.profile}`],
        cwd: fixture.fixtureRoot,
      });
      syntheticIdentity = probeProcess(child.child.pid);
      return child;
    },
  });
  const result = await host.completion;
  assert.equal(result.status, 'fail');
  assert.equal(result.ownership, 'ambiguous');
  assert.equal(result.cleanup.confirmedClosed, false);
  assert.equal(result.terminationAttempts.length, 1);
  assert.equal(result.terminationAttempts[0].disposition, 'ambiguous');
  assert.equal(removeFixture(fixture, host).disposition, 'preserved');
  assert.equal(existsSync(fixture.fixtureRoot), true);
  assert.ok(
    groupMembers(syntheticIdentity.detachedPgid).some(
      (member) => member.pid === syntheticIdentity.pid,
    ),
  );
  await sentinel.verify();
  const current = probeProcess(syntheticIdentity.pid);
  assert.equal(current.uid, syntheticIdentity.uid);
  assert.equal(current.startIdentity, syntheticIdentity.startIdentity);
  assert.equal(current.detachedPgid, syntheticIdentity.detachedPgid);
  const harnessClose = new Promise((done) => host.child.once('close', done));
  process.kill(-syntheticIdentity.detachedPgid, 'SIGKILL');
  await waitFor(() => groupMembers(syntheticIdentity.detachedPgid).length === 0);
  await harnessClose;
});

test('synthetic unsafe directory replacement is preserved instead of recursively removed', () => {
  const directory = evidence();
  const fixture = makeOwnerFixture(randomUUID());
  const owned = fixture.paths.w;
  rmSync(owned, { recursive: true });
  mkdirSync(owned, { mode: 0o700 });
  writeFileSync(join(owned, 'replacement'), 'preserve', { mode: 0o600 });
  assert.equal(removeFixture(fixture).disposition, 'preserved');
  assert.equal(readFileSync(join(owned, 'replacement'), 'utf8'), 'preserve');
  rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  rmSync(directory, { recursive: true, force: true });
});

test('synthetic home and XDG identity changes preserve replacement sentinels', () => {
  for (const name of ['home', 'xdg'])
    for (const change of ['mode', 'replacement', 'symlink']) {
      const scratch = evidence();
      const fixture = makeOwnerFixture(randomUUID());
      const target = fixture.paths[name];
      const outside = join(scratch, `${name}-${change}-sentinel`);
      writeFileSync(outside, 'preserve', { flag: 'wx', mode: 0o600 });
      if (change === 'mode') chmodSync(target, 0o755);
      else {
        rmSync(target, { recursive: true });
        if (change === 'replacement') mkdirSync(target, { mode: 0o700 });
        else symlinkSync(outside, target);
      }
      if (change === 'replacement')
        writeFileSync(join(target, 'sentinel'), 'preserve', { mode: 0o600 });
      const original = fixture.identities.find((identity) => identity.path === target);
      const result = removeFixture(fixture);
      const targetNow = lstatSync(target);
      assert.equal(result.disposition, 'preserved');
      assert.equal(readFileSync(outside, 'utf8'), 'preserve');
      if (change === 'replacement')
        assert.equal(readFileSync(join(target, 'sentinel'), 'utf8'), 'preserve');
      writeQaEvidence('home-xdg-identity-refusal', {
        name,
        change,
        disposition: result.disposition,
        originalIdentity: {
          uid: original.uid,
          mode: original.mode,
          dev: original.dev,
          ino: original.ino,
        },
        observedIdentity: {
          uid: targetNow.uid,
          mode: targetNow.mode & 0o777,
          dev: targetNow.dev,
          ino: targetNow.ino,
          isDirectory: targetNow.isDirectory(),
          isSymlink: targetNow.isSymbolicLink(),
        },
        sentinelOutsideSha256: createHash('sha256').update(readFileSync(outside)).digest('hex'),
        sentinelOutsidePreserved: readFileSync(outside, 'utf8') === 'preserve',
        replacementSentinelPreserved:
          change !== 'replacement' || readFileSync(join(target, 'sentinel'), 'utf8') === 'preserve',
        reportedPaths: result.paths,
      });
      rmSync(fixture.fixtureRoot, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
});

test('synthetic runner result preserves allocation failure and separate rollback EIO', async (t) => {
  const scratch = evidence();
  let leftoverRoot;
  let leftoverIdentity;
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  t.after(() => {
    if (!leftoverRoot || !existsSync(leftoverRoot)) return;
    const identity = lstatSync(leftoverRoot);
    assert.equal(identity.isDirectory(), true);
    assert.equal(identity.isSymbolicLink(), false);
    assert.equal(identity.uid, leftoverIdentity.uid);
    assert.equal(identity.dev, leftoverIdentity.dev);
    assert.equal(identity.ino, leftoverIdentity.ino);
    assert.equal(identity.mode & 0o777, leftoverIdentity.mode);
    assert.equal(identity.uid, process.getuid());
    assert.match(leftoverRoot, /^\/private\/tmp\/h-[a-f0-9]{32}$/);
    assert.equal(realpathSync(leftoverRoot), leftoverIdentity.canonical);
    rmSync(leftoverRoot, { recursive: true });
  });
  await assert.rejects(
    runExtensionHost({
      evidenceParent: scratch,
      runtimeFactory: () => ({ portable: join(scratch, 'portable') }),
      fixtureHooks: {
        beforeMarkerWrite(_markerPath, marker) {
          leftoverRoot = marker.fixtureRoot;
          const identity = lstatSync(leftoverRoot);
          leftoverIdentity = {
            dev: identity.dev,
            ino: identity.ino,
            uid: identity.uid,
            mode: identity.mode & 0o777,
            canonical: realpathSync(leftoverRoot),
          };
          throw Object.assign(new Error('allocation'), { code: 'ENOSPC' });
        },
        beforeRollbackRemove(operation, path) {
          if (operation === 'rmdir' && path.endsWith('/g/xdg')) {
            writeFileSync(join(path, '..', 'sentinel'), 'preserve', {
              flag: 'wx',
              mode: 0o600,
            });
            throw Object.assign(new Error('rollback'), { code: 'EIO' });
          }
        },
      },
    }),
    (error) => {
      assert.equal(error.code, 'ENOSPC');
      assert.equal(error.stage, 'fixture-allocation');
      const summary = JSON.parse(readFileSync(join(error.evidence, 'runner-result.json'), 'utf8'));
      assert.equal(summary.reason, 'ENOSPC');
      assert.equal(summary.cleanup.disposition, 'cleanup-failed');
      assert.equal(summary.cleanupError.stage, 'partial-fixture-rollback');
      assert.equal(summary.cleanupError.code, 'EIO');
      leftoverRoot = summary.cleanup.paths[0];
      assert.match(leftoverRoot, /^\/private\/tmp\/h-[a-f0-9]{32}$/);
      assert.ok(summary.cleanup.paths.includes(join(summary.cleanup.paths[0], 'g/xdg')));
      assert.ok(summary.cleanup.paths.includes(join(summary.cleanup.paths[0], 'g/sentinel')));
      const sentinelPath = join(leftoverRoot, 'g/sentinel');
      writeQaEvidence('partial-allocation-cleanup', {
        primaryFailure: { code: error.code, stage: error.stage },
        cleanupFailure: summary.cleanupError,
        leftoverPaths: summary.cleanup.paths,
        sentinelPath,
        sentinelSha256: createHash('sha256').update(readFileSync(sentinelPath)).digest('hex'),
        sentinelPreserved: readFileSync(sentinelPath, 'utf8') === 'preserve',
        fixtureIdentity: leftoverIdentity,
      });
      return true;
    },
  );
});

test('runner setup failures retain writable summaries and repeated finalization is bounded', async (t) => {
  const scratch = evidence();
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const outputMessages = [];
  const successChild = (
    configuration,
    script = `const fs=require('node:fs');fs.writeFileSync(process.env.DEVLOOM_EVIDENCE_DIR+'/result.json','{"status":"pass"}',{flag:'wx',mode:384})`,
  ) =>
    launchOwned({
      ...configuration,
      command: process.execPath,
      args: ['-e', script],
      cwd: configuration.fixtureRoot,
    });
  const cases = [
    {
      name: 'settings',
      options: {
        writeSettings() {
          throw Object.assign(new Error('settings'), { code: 'EIO' });
        },
      },
    },
    {
      name: 'fixture-git',
      options: {
        runFixtureGit() {
          throw Object.assign(new Error('git'), { code: 'EIO' });
        },
      },
    },
    {
      name: 'spawn',
      options: {
        launch() {
          throw Object.assign(new Error('spawn'), { code: 'EIO' });
        },
      },
    },
    {
      name: 'log-bound',
      options: {
        launch(configuration) {
          const script = `const fs=require('node:fs');fs.writeFileSync(process.env.DEVLOOM_EVIDENCE_DIR+'/result.json','{"status":"pass"}',{flag:'wx',mode:384});let n=0;const timer=setInterval(()=>{process.stdout.write(Buffer.alloc(1048576,65));if(++n===6){clearInterval(timer);process.exit(0)}},5)`;
          return successChild(configuration, script);
        },
      },
    },
    {
      name: 'summary-write',
      options: {
        launch(configuration) {
          return successChild(configuration);
        },
        writeRunnerResult() {
          throw Object.assign(new Error('summary'), { code: 'EIO' });
        },
        writeOutput(message) {
          outputMessages.push(message);
        },
      },
    },
  ];
  const outcomes = [];
  for (const item of cases) {
    await assert.rejects(runExtensionHost({ evidenceParent: parent, ...item.options }), (error) => {
      const summaryPath = join(error.evidence, 'runner-result.json');
      if (item.name === 'summary-write') {
        assert.equal(error.code, 'EIO');
        assert.equal(error.stage, 'runner-result');
        assert.equal(error.runnerResultFailure, 'EIO');
        assert.equal(existsSync(summaryPath), false);
        assert.deepEqual(outputMessages, []);
        outcomes.push({
          name: item.name,
          code: error.code,
          stage: error.stage,
          successPrinted: false,
        });
        return true;
      }
      const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
      assert.equal(summary.status, 'fail');
      assert.equal(summary.cleanup.disposition, 'removed');
      assert.equal(summary.childMayRemain, false);
      if (item.name === 'log-bound') {
        const launcher = JSON.parse(
          readFileSync(join(error.evidence, 'launcher-result.json'), 'utf8'),
        );
        assert.equal(summary.reason, 'EXTENSION_HOST_FAILED');
        assert.equal(summary.stage, 'native-completion');
        assert.equal(summary.confirmedClosed, true);
        assert.equal(launcher.firstError, 'LOG_BOUND');
      } else {
        assert.equal(summary.reason, 'EIO');
        assert.equal(
          summary.stage,
          item.name === 'spawn'
            ? 'native-launch'
            : item.name === 'fixture-git'
              ? 'git-fixture'
              : item.name,
        );
        assert.equal(summary.hostPid, null);
      }
      outcomes.push({ name: item.name, summary, evidence: error.evidence });
      return true;
    });
  }
  const outputOutcome = await runExtensionHost({
    evidenceParent: parent,
    launch(configuration) {
      return successChild(configuration);
    },
    writeOutput() {
      throw Object.assign(new Error('stdout'), { code: 'EPIPE' });
    },
  });
  const outputSummary = JSON.parse(
    readFileSync(join(outputOutcome.evidence, 'runner-result.json'), 'utf8'),
  );
  assert.equal(outputSummary.status, 'pass');
  outcomes.push({
    name: 'stdout-failure-after-summary',
    status: outputSummary.status,
    nonfatal: true,
  });

  const fixture = makeOwnerFixture(randomUUID());
  const directory = evidence();
  const host = launchSynthetic(fixture, directory, 'setTimeout(()=>process.exit(0),40)', {
    timeoutMs: 100,
  });
  const completion = await host.completion;
  const attemptsBefore = [...completion.terminationAttempts];
  await host.terminate();
  await host.terminate();
  assert.equal(host.state.finalized, true);
  assert.deepEqual(host.state.terminationAttempts, attemptsBefore);
  assert.equal(host.state.finalization.listenersDisposed, true);
  assert.equal(host.state.finalization.streamsClosed, true);
  assert.equal(removeFixture(fixture, host).disposition, 'removed');
  outcomes.push({
    name: 'repeated-finalization',
    status: completion.status,
    finalized: host.state.finalized,
    terminationAttempts: host.state.terminationAttempts,
    finalization: host.state.finalization,
  });
  writeQaEvidence('setup-interrupt-finalize', {
    outcomes,
    allWritableFailuresReported: outcomes
      .filter((item) => item.summary)
      .every((item) => item.summary.status === 'fail'),
    summaryWriteFailureSuppressedSuccess: outputMessages.length === 0,
    stdoutFailureAfterSummaryRemainsPass: outputSummary.status === 'pass',
    repeatedFinalizationStable:
      host.state.finalized && host.state.terminationAttempts.length === attemptsBefore.length,
  });
  rmSync(directory, { recursive: true, force: true });
});

test('actual runner stops before fixture Git and native launch on a bad runtime artifact', async (t) => {
  if (process.env.DEVLOOM_RUNNER_PROCESS_QA !== '1')
    return t.skip('Run after pinned native artifacts are built');
  const scratch = evidence();
  const foreignRuntime = join(scratch, 'foreign-electron');
  writeFileSync(foreignRuntime, 'synthetic runtime sentinel', { flag: 'wx', mode: 0o700 });
  const digest = createHash('sha256').update(readFileSync(foreignRuntime)).digest('hex');
  const events = [];
  const sourceCalls = [];
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  await assert.rejects(
    runExtensionHost({
      evidenceParent: process.env.DEVLOOM_EVIDENCE_DIR,
      runtimeFactory: () => ({ ...nativeRuntime(process.cwd()), executable: foreignRuntime }),
      trace(event) {
        events.push(event);
      },
      observeSourceGit(call) {
        sourceCalls.push({ executable: call.executable, args: call.args, cwd: call.cwd });
      },
    }),
    (error) => {
      assert.equal(error.code, 'PREPARED_ARTIFACT_OUTSIDE_BOUNDARY');
      assert.equal(error.stage, 'source-preflight');
      const runner = JSON.parse(readFileSync(join(error.evidence, 'runner-result.json'), 'utf8'));
      assert.equal(runner.status, 'fail');
      assert.equal(runner.sourcePreflight, 'source-checked');
      assert.equal(runner.hostPid, null);
      assert.equal(runner.cleanup.disposition, 'removed');
      assert.equal(sourceCalls[0].executable, '/opt/homebrew/bin/git');
      assert.deepEqual(sourceCalls[0].args.slice(0, 1), ['--version']);
      assert.deepEqual(events, ['before-source-preflight']);
      writeQaEvidence('runner-preflight-negative', {
        failure: { code: error.code, stage: error.stage },
        runner: {
          status: runner.status,
          sourcePreflight: runner.sourcePreflight,
          hostPid: runner.hostPid,
          cleanup: runner.cleanup,
        },
        sourceGitFirstCall: sourceCalls[0],
        trace: events,
        fixtureGitAndNativeSkipped:
          !events.includes('fixture-git') && !events.includes('native-launch'),
        foreignRuntimeSha256Before: digest,
        foreignRuntimeSha256After: createHash('sha256')
          .update(readFileSync(foreignRuntime))
          .digest('hex'),
      });
      return true;
    },
  );
  assert.equal(createHash('sha256').update(readFileSync(foreignRuntime)).digest('hex'), digest);
  assert.deepEqual(readdirSync(scratch), ['foreign-electron']);
});

test('synthetic host rejects missing and malformed result files without signaling closed children', async (t) => {
  const directory = evidence();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const content of [null, '{bad']) {
    const iteration = join(directory, randomUUID());
    mkdirSync(iteration, { mode: 0o700 });
    const fixture = makeOwnerFixture(randomUUID());
    const script =
      content === null
        ? 'setTimeout(()=>process.exit(0),40)'
        : `const fs=require('node:fs');fs.writeFileSync(process.env.DEVLOOM_EVIDENCE_DIR+"/result.json",${JSON.stringify(content)});setTimeout(()=>process.exit(0),40)`;
    const host = launchSynthetic(fixture, iteration, script);
    const result = await host.completion;
    assert.equal(result.status, content === null ? 'pass' : 'fail');
    assert.equal(result.result ?? null, null);
    assert.equal(result.cleanup.confirmedClosed, true);
    assert.deepEqual(result.terminationAttempts, []);
    assert.equal(removeFixture(fixture, host).disposition, 'removed');
    rmSync(iteration, { recursive: true, force: true });
  }
});

test('actual runner writes cleanup EIO beside passing and failing host outcomes', async (t) => {
  if (process.env.DEVLOOM_RUNNER_PROCESS_QA !== '1')
    return t.skip('Run after pinned native artifacts are built');
  const fixtureIdentities = [];
  t.after(() => {
    for (const expected of fixtureIdentities) {
      const identity = lstatSync(expected.path);
      assert.equal(identity.isDirectory(), true);
      assert.equal(identity.isSymbolicLink(), false);
      assert.equal(identity.dev, expected.dev);
      assert.equal(identity.ino, expected.ino);
      assert.equal(identity.uid, expected.uid);
      assert.equal(identity.mode & 0o777, expected.mode);
      assert.equal(identity.uid, process.getuid());
      assert.equal(realpathSync(expected.path), expected.canonical);
      rmSync(expected.path, { recursive: true });
    }
  });
  for (const hostResult of ['pass', 'malformed']) {
    let fixtureRoot;
    await assert.rejects(
      runExtensionHost({
        evidenceParent: process.env.DEVLOOM_EVIDENCE_DIR,
        timeoutMs: 100,
        launch(configuration) {
          const payload = hostResult === 'pass' ? '{"status":"pass"}' : '{malformed';
          const script = `const fs=require('node:fs');fs.writeFileSync(process.env.DEVLOOM_EVIDENCE_DIR+'/result.json',${JSON.stringify(payload)},{flag:'wx',mode:384});setTimeout(()=>process.exit(0),40)`;
          return launchOwned({
            ...configuration,
            command: process.execPath,
            args: ['-e', script],
            cwd: configuration.fixtureRoot,
          });
        },
        fixtureCleanup: {
          removeTree(path) {
            fixtureRoot = path;
            const identity = lstatSync(path);
            fixtureIdentities.push({
              path,
              dev: identity.dev,
              ino: identity.ino,
              uid: identity.uid,
              mode: identity.mode & 0o777,
              canonical: realpathSync(path),
            });
            rmSync(join(path, 'u'), { recursive: true });
            throw Object.assign(new Error('cleanup'), { code: 'EIO' });
          },
        },
      }),
      (error) => {
        const runner = JSON.parse(readFileSync(join(error.evidence, 'runner-result.json'), 'utf8'));
        assert.equal(runner.status, 'fail');
        assert.equal(
          runner.reason,
          hostResult === 'pass' ? 'FIXTURE_CLEANUP_FAILED' : 'EXTENSION_HOST_FAILED',
        );
        assert.equal(runner.cleanup.disposition, 'cleanup-failed');
        assert.equal(runner.cleanupError.code, 'EIO');
        assert.equal(runner.cleanupError.stage, 'fixture-cleanup');
        assert.ok(runner.cleanup.paths.includes(fixtureRoot));
        assert.ok(!runner.cleanup.paths.includes(join(fixtureRoot, 'u')));
        assert.equal(existsSync(join(fixtureRoot, 'u')), false);
        return true;
      },
    );
  }
});
