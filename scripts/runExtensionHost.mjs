import { execFileSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { strictGit } from './componentInventoryGit.mjs';
import { launchOwned } from './localGitSession.mjs';
import { localEnvironment, nativeRuntime, routingKeys } from './localExtensionInstall.mjs';
import { check, root, upstream } from './upstream.mjs';

export function createEvidenceDirectory(parent) {
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, 'session-'));
}

const canonicalSourceRoot = realpathSync(root);
const fixedGit = '/opt/homebrew/bin/git';
const gitVersion = 'git version 2.53.0';
const pinnedNode = join(root, '.tools/node-v24.22.1-darwin-arm64/bin');
const safeCode = (error) => {
  const candidate = error?.code ?? error?.message;
  return typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate)
    ? candidate
    : 'RUNNER_FAILED';
};
const dirNames = ['u', 'e', 'a', 'w', 'g'];
const compileCacheKeys = [
  'VSCODE_NODE_COMPILE_CACHE_MEASUREMENTS',
  'VSCODE_GENERATE_NODE_COMPILE_CACHE',
  'VSCODE_NODE_COMPILE_CACHE_ROOT',
  'VSCODE_NODE_COMPILE_CACHE_KIND',
];
const environmentKeys = [
  ...routingKeys,
  ...compileCacheKeys,
  'HOME',
  'XDG_CONFIG_HOME',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
];

function canonicalEvidenceParent(value) {
  if (!value || !isAbsolute(value)) throw new Error('INVALID_EVIDENCE_PARENT');
  const parent = realpathSync(value);
  if (parent === canonicalSourceRoot || parent.startsWith(`${canonicalSourceRoot}/`))
    throw new Error('INTERNAL_EVIDENCE_PARENT');
  return parent;
}

function directorySnapshot(path) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o700 ||
    realpathSync(path) !== path
  )
    throw new Error('FIXTURE_DIRECTORY_IDENTITY');
  return {
    path,
    canonical: path,
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    mode: stat.mode & 0o777,
  };
}

function sameDirectory(identity) {
  const current = directorySnapshot(identity.path);
  return (
    current.dev === identity.dev &&
    current.ino === identity.ino &&
    current.uid === identity.uid &&
    current.mode === identity.mode &&
    current.canonical === identity.canonical
  );
}

function noFollowRead(path, expected) {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW;
  const descriptor = openSync(path, flags);
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== expected.mode
    )
      throw new Error('FIXTURE_MARKER_IDENTITY');
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

function markerSnapshot(path, marker) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o600
  )
    throw new Error('FIXTURE_MARKER_IDENTITY');
  const identity = {
    path,
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    mode: stat.mode & 0o777,
  };
  if (noFollowRead(path, identity) !== JSON.stringify(marker))
    throw new Error('FIXTURE_MARKER_CONTENT');
  return identity;
}

function expectedDirectChildren(identity, identities, markerIdentity) {
  const children = identities
    .filter(
      (candidate) =>
        candidate.path !== identity.path && join(candidate.path, '..') === identity.path,
    )
    .map((candidate) => candidate.path.slice(identity.path.length + 1));
  if (markerIdentity && join(markerIdentity.path, '..') === identity.path)
    children.push(markerIdentity.path.slice(identity.path.length + 1));
  return children.sort();
}

function verifyCapturedInventory(identities, markerIdentity) {
  for (const identity of identities) {
    if (!sameDirectory(identity)) throw new Error('FIXTURE_DIRECTORY_REPLACED');
    const expected = expectedDirectChildren(identity, identities, markerIdentity);
    const actual = readdirSync(identity.path).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error('FIXTURE_DIRECTORY_CONTENTS');
  }
}

function observeTree(
  path,
  observations,
  directoryIdentities,
  fileIdentities,
  realpath = realpathSync,
  seen = new Set(),
) {
  if (seen.has(path)) return;
  seen.add(path);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') observations.push(`UNKNOWN:${path}:${safeCode(error)}`);
    return;
  }
  observations.push(path);
  const identity = directoryIdentities.get(path);
  if (
    identity &&
    (!stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== identity.dev ||
      stat.ino !== identity.ino ||
      stat.uid !== identity.uid ||
      (stat.mode & 0o777) !== identity.mode)
  ) {
    observations.push(`UNKNOWN:${path}:IDENTITY_CHANGED`);
    return;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    const file = fileIdentities.get(path);
    if (
      file &&
      (stat.dev !== file.dev ||
        stat.ino !== file.ino ||
        stat.uid !== file.uid ||
        (stat.mode & 0o777) !== file.mode)
    )
      observations.push(`UNKNOWN:${path}:IDENTITY_CHANGED`);
    return;
  }
  let canonical;
  try {
    canonical = realpath(path);
  } catch (error) {
    observations.push(`UNKNOWN:${path}:${safeCode(error)}`);
    return;
  }
  if (
    !identity ||
    stat.dev !== identity.dev ||
    stat.ino !== identity.ino ||
    stat.uid !== identity.uid ||
    (stat.mode & 0o777) !== identity.mode ||
    canonical !== identity.canonical
  ) {
    observations.push(`UNKNOWN:${path}:IDENTITY_CHANGED`);
    return;
  }
  let names;
  try {
    names = readdirSync(path);
  } catch (error) {
    observations.push(`UNKNOWN:${path}:${safeCode(error)}`);
    return;
  }
  for (const name of names.sort())
    observeTree(
      join(path, name),
      observations,
      directoryIdentities,
      fileIdentities,
      realpath,
      seen,
    );
}

function observedPaths(paths, identities = [], markerIdentity = null, realpath = realpathSync) {
  const observations = [];
  const unique = [...new Set(paths)].sort((a, b) => a.length - b.length);
  const roots = unique.filter(
    (path) => !unique.some((parent) => parent !== path && path.startsWith(`${parent}/`)),
  );
  const directoryIdentities = new Map(identities.map((identity) => [identity.path, identity]));
  const fileIdentities = new Map(markerIdentity ? [[markerIdentity.path, markerIdentity]] : []);
  for (const path of roots)
    observeTree(path, observations, directoryIdentities, fileIdentities, realpath);
  return observations;
}

function rollbackPartialFixture(fixture, beforeRemove) {
  try {
    if (!fixture.identities.some((identity) => identity.path === fixture.fixtureRoot))
      throw new Error('FIXTURE_ROOT_UNCAPTURED');
    let markerIdentity = fixture.markerIdentity;
    try {
      lstatSync(fixture.markerPath);
      if (!markerIdentity) throw new Error('FIXTURE_MARKER_UNCAPTURED');
      markerIdentity = markerSnapshot(fixture.markerPath, fixture.marker);
      if (
        markerIdentity.dev !== fixture.markerIdentity.dev ||
        markerIdentity.ino !== fixture.markerIdentity.ino
      )
        throw new Error('FIXTURE_MARKER_REPLACED');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (markerIdentity) throw new Error('FIXTURE_MARKER_MISSING');
    }
    verifyCapturedInventory(fixture.identities, markerIdentity);
    if (markerIdentity) {
      beforeRemove?.('unlink', fixture.markerPath);
      const current = markerSnapshot(fixture.markerPath, fixture.marker);
      if (current.dev !== markerIdentity.dev || current.ino !== markerIdentity.ino)
        throw new Error('FIXTURE_MARKER_REPLACED');
      unlinkSync(fixture.markerPath);
      fixture.markerIdentity = null;
    }
    const remaining = new Set(fixture.identities.map((identity) => identity.path));
    for (const identity of [...fixture.identities].sort((a, b) => b.path.length - a.path.length)) {
      if (!sameDirectory(identity)) throw new Error('FIXTURE_DIRECTORY_REPLACED');
      const children = expectedDirectChildren(
        identity,
        fixture.identities.filter((candidate) => remaining.has(candidate.path)),
        null,
      );
      if (JSON.stringify(readdirSync(identity.path).sort()) !== JSON.stringify(children))
        throw new Error('FIXTURE_DIRECTORY_CONTENTS');
      beforeRemove?.('rmdir', identity.path);
      rmdirSync(identity.path);
      remaining.delete(identity.path);
    }
    return { paths: [], error: null };
  } catch (error) {
    return {
      paths: observedPaths([fixture.fixtureRoot], fixture.identities, fixture.markerIdentity),
      error: safeCode(error),
    };
  }
}

export function makeOwnerFixture(sessionId, hooks = {}) {
  const nonce = randomBytes(16).toString('hex');
  const allocatedRoot = join('/tmp', `h-${nonce}`);
  const fixtureRoot =
    realpathSync('/tmp') === '/private/tmp' ? join('/private/tmp', `h-${nonce}`) : allocatedRoot;
  const paths = Object.fromEntries(dirNames.map((name) => [name, join(fixtureRoot, name)]));
  paths.home = join(paths.g, 'home');
  paths.xdg = join(paths.g, 'xdg');
  const marker = { schemaVersion: 1, nonce, sessionId, fixtureRoot, paths };
  const markerPath = join(fixtureRoot, `.owner-${sessionId}.json`);
  const identities = [];
  const fixture = {
    nonce,
    sessionId,
    fixtureRoot,
    paths,
    marker,
    markerPath,
    identities,
    markerIdentity: null,
  };
  let rootCreated = false;
  try {
    mkdirSync(fixtureRoot, { mode: 0o700 });
    rootCreated = true;
    chmodSync(fixtureRoot, 0o700);
    identities.push(directorySnapshot(fixtureRoot));
    for (const name of ['u', 'e', 'a', 'w', 'g', 'home', 'xdg']) {
      const path = paths[name];
      mkdirSync(path, { mode: 0o700 });
      hooks.afterDirectoryCreated?.(name, path);
      chmodSync(path, 0o700);
      identities.push(directorySnapshot(path));
      hooks.afterDirectory?.(name, path);
    }
    hooks.beforeMarkerWrite?.(markerPath, marker);
    writeFileSync(markerPath, JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
    fixture.markerIdentity = markerSnapshot(markerPath, marker);
    return fixture;
  } catch (error) {
    const rollback = rootCreated
      ? rollbackPartialFixture(fixture, hooks.beforeRollbackRemove)
      : { paths: [], error: null };
    error.leftovers = rollback.paths;
    if (rollback.error)
      error.cleanupError = {
        stage: 'partial-fixture-rollback',
        code: rollback.error,
        paths: rollback.paths,
      };
    error.fixtureRoot = fixtureRoot;
    throw error;
  }
}

function validateFixture(fixture) {
  try {
    if (!fixture.markerIdentity || !fixture.identities.every(sameDirectory)) return false;
    const current = markerSnapshot(fixture.markerPath, fixture.marker);
    return current.dev === fixture.markerIdentity.dev && current.ino === fixture.markerIdentity.ino;
  } catch {
    return false;
  }
}

export function removeFixture(fixture, host, options = {}) {
  const spawned = Boolean(host?.state.pid);
  const processSafe =
    !spawned ||
    (host.state.finalized === true &&
      host.state.ownership !== 'ambiguous' &&
      host.state.cleanup?.confirmedClosed === true &&
      host.state.cleanup?.markerValid === true);
  if (!processSafe || !validateFixture(fixture))
    return {
      disposition: 'preserved',
      paths: observedPaths(
        [fixture.fixtureRoot, ...fixture.identities.map((identity) => identity.path)],
        fixture.identities,
        fixture.markerIdentity,
        options.realpath ?? realpathSync,
      ),
    };
  try {
    options.beforeRemove?.(fixture);
    (options.removeTree ?? rmSync)(fixture.fixtureRoot, { recursive: true });
    return { disposition: 'removed', paths: [] };
  } catch (error) {
    return {
      disposition: 'cleanup-failed',
      code: safeCode(error),
      paths: observedPaths(
        [fixture.fixtureRoot, ...fixture.identities.map((identity) => identity.path)],
        fixture.identities,
        fixture.markerIdentity,
        options.realpath ?? realpathSync,
      ),
    };
  }
}

export function checkSocketBounds(profile, version) {
  if (process.platform !== 'darwin') return;
  const paths = ['main', 'shared'].map((type) =>
    join(profile, `${version.slice(0, 4)}-${type.slice(0, 6)}.sock`),
  );
  if (paths.some((path) => Buffer.byteLength(path, 'utf8') >= 103))
    throw new Error('IPC_PATH_TOO_LONG');
}

export function isolatedEnvironment(
  evidence,
  gitRuntime,
  sourceEnvironment = process.env,
  owned = { home: join(gitRuntime, 'home'), xdg: join(gitRuntime, 'xdg') },
) {
  const inherited = { ...sourceEnvironment };
  const routingNames = new Set(routingKeys.map((key) => key.toUpperCase()));
  for (const key of Object.keys(inherited)) {
    const normalized = key.toUpperCase();
    if (
      normalized.startsWith('GIT_') ||
      normalized.startsWith('NODE_') ||
      normalized.startsWith('VSCODE_NODE_COMPILE_CACHE_') ||
      normalized === 'VSCODE_GENERATE_NODE_COMPILE_CACHE' ||
      normalized === 'HOME' ||
      normalized === 'XDG_CONFIG_HOME' ||
      routingNames.has(normalized)
    )
      delete inherited[key];
  }
  const env = localEnvironment(canonicalSourceRoot, inherited);
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (
      routingNames.has(normalized) ||
      normalized.startsWith('VSCODE_NODE_COMPILE_CACHE_') ||
      normalized === 'VSCODE_GENERATE_NODE_COMPILE_CACHE' ||
      normalized.startsWith('GIT_') ||
      normalized.startsWith('NODE_')
    )
      delete env[key];
  }
  Object.assign(env, {
    DEVLOOM_EVIDENCE_DIR: evidence,
    DEVLOOM_GIT_TEST_DIRECTORY: gitRuntime,
    HOME: owned.home,
    XDG_CONFIG_HOME: owned.xdg,
    NODE_ENV: 'development',
    VSCODE_DEV: '1',
    VSCODE_CLI: '1',
    VSCODE_SKIP_PRELAUNCH: '1',
    ELECTRON_ENABLE_STACK_DUMPING: '1',
    ELECTRON_ENABLE_LOGGING: '1',
    PATH: `${fixedGit.slice(0, fixedGit.lastIndexOf('/'))}:${pinnedNode}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  });
  return env;
}

function gitFixture(workspace, gitRuntime, env) {
  if (!existsSync(fixedGit)) throw new Error('FIXED_GIT_MISSING');
  const version = execFileSync(fixedGit, ['--version'], { encoding: 'utf8', env }).trim();
  if (version !== gitVersion) throw new Error('FIXED_GIT_VERSION');
  const run = (args) =>
    execFileSync(
      fixedGit,
      [
        '-c',
        `core.hooksPath=${join(gitRuntime, 'hooks')}`,
        '-c',
        'credential.helper=',
        '-c',
        'core.askPass=',
        '-c',
        'commit.gpgSign=false',
        '-c',
        'tag.gpgSign=false',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'diff.external=',
        '-c',
        'core.pager=cat',
        '-c',
        'pager.diff=false',
        '-c',
        'core.attributesFile=/dev/null',
        '-c',
        'core.excludesFile=/dev/null',
        ...args,
      ],
      { cwd: workspace, env, stdio: 'pipe' },
    );
  mkdirSync(join(gitRuntime, 'hooks'), { mode: 0o700 });
  chmodSync(join(gitRuntime, 'hooks'), 0o700);
  const template = join(gitRuntime, 'empty-template');
  mkdirSync(template, { mode: 0o700 });
  chmodSync(template, 0o700);
  run(['init', `--template=${template}`]);
  run(['config', 'user.name', 'Devloom Local Fixture']);
  run(['config', 'user.email', 'fixture@invalid.local']);
  run(['config', 'git.path', fixedGit]);
  writeFileSync(join(workspace, 'fixture.ts'), 'baseline\n', { flag: 'wx', mode: 0o600 });
  run(['add', 'fixture.ts']);
  run(['commit', '-m', 'fixture']);
  writeFileSync(join(workspace, 'fixture.ts'), 'changed\n');
}

export function startOwnedHost(options) {
  const {
    runtime,
    fixture,
    evidence,
    env,
    launch = launchOwned,
    timeoutMs = 90000,
    probes = {},
  } = options;
  const profile = fixture.paths.u;
  const args = [
    '.',
    fixture.paths.w,
    `--user-data-dir=${profile}`,
    `--extensions-dir=${fixture.paths.e}`,
    `--shared-data-dir=${fixture.paths.a}`,
    `--extensionDevelopmentPath=${join(canonicalSourceRoot, 'extensions/devloom-bootstrap')}`,
    `--extensionTestsPath=${join(root, 'dist/tests/extensionHost.js')}`,
    '--force-disable-user-env',
    '--disable-telemetry',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    ...[
      'GitHub.copilot-chat',
      'GitHub.copilot',
      'vscode.github-authentication',
      'vscode.microsoft-authentication',
    ].map((id) => `--disable-extension=${id}`),
  ];
  return launch({
    command: runtime.executable,
    args,
    cwd: runtime.cwd,
    env,
    fixtureRoot: fixture.fixtureRoot,
    profile,
    nonce: fixture.nonce,
    sessionId: fixture.sessionId,
    sourceRoot: canonicalSourceRoot,
    evidence,
    timeoutMs,
    ...probes,
  });
}

function assertCanonicalArtifact(path, boundary, executable = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('PREPARED_ARTIFACT_MISSING');
  const canonical = realpathSync(path);
  const canonicalBoundary = realpathSync(boundary);
  if (canonical !== path || !canonical.startsWith(`${canonicalBoundary}/`))
    throw new Error('PREPARED_ARTIFACT_OUTSIDE_BOUNDARY');
  if (executable) {
    try {
      accessSync(canonical, constants.X_OK);
    } catch {
      throw new Error('PREPARED_ARTIFACT_NOT_EXECUTABLE');
    }
  }
}

export function assertPreparedArtifacts(runtime, source, roots = { root, upstream }) {
  const overlayPath = join(roots.upstream, 'product.overrides.json');
  const overlayBytes = `${JSON.stringify(source.overlay, null, 2)}\n`;
  assertCanonicalArtifact(overlayPath, roots.upstream);
  if (readFileSync(overlayPath, 'utf8') !== overlayBytes) throw new Error('OVERLAY_NOT_PUBLISHED');
  for (const path of [
    join(roots.upstream, 'out/cli.js'),
    join(roots.upstream, 'out/vs/code/electron-main/main.js'),
    join(roots.upstream, 'extensions/git/out/main.js'),
  ])
    assertCanonicalArtifact(path, roots.upstream);
  for (const path of [
    join(roots.root, 'dist/tests/extensionHost.js'),
    join(roots.root, 'extensions/devloom-bootstrap/dist/extension.js'),
  ])
    assertCanonicalArtifact(path, roots.root);
  assertCanonicalArtifact(runtime.executable, roots.upstream, true);
  assertCanonicalArtifact(
    join(roots.root, 'crates/devloom-sidecar/target/debug/devloom-sidecar'),
    roots.root,
    true,
  );
  const electron = join(roots.upstream, '.build/electron');
  const electronStat = lstatSync(electron);
  if (
    electronStat.isSymbolicLink() ||
    !electronStat.isDirectory() ||
    realpathSync(electron) !== electron ||
    !realpathSync(electron).startsWith(`${realpathSync(roots.upstream)}/`)
  )
    throw new Error('PREPARED_ELECTRON_MISSING');
}

function readOnlySourceCheck(env, observeGit) {
  const runGit = strictGit(root, upstream, {
    executable: fixedGit,
    spawn: (executable, args, options) => {
      observeGit?.({ executable, args, cwd: options.cwd, env });
      return execFileSync(executable, args, { ...options, env });
    },
  });
  return check({ readOnly: true, runGit });
}

export async function runExtensionHost(options = {}) {
  let stage = 'evidence-parent';
  const parentEnvironment = options.parentEnvironment ?? process.env;
  const parent = canonicalEvidenceParent(
    options.evidenceParent ?? parentEnvironment.DEVLOOM_EVIDENCE_DIR,
  );
  const evidence = createEvidenceDirectory(parent);
  chmodSync(evidence, 0o700);
  const sessionId = randomUUID();
  let fixture;
  let host;
  let failure;
  let failureStage;
  let allocationLeftovers = [];
  let cleanup = { disposition: 'not-allocated', paths: [] };
  let cleanupError;
  let runnerResultFailure;
  let childUnrefCompleted = false;
  let sourcePreflight;
  let sourcePreflightPassed = false;
  let workspacePath;
  const resultPath = join(evidence, 'result.json');
  let routing = environmentKeys.map((key) => ({ key, childPresent: false }));
  try {
    stage = 'native-runtime';
    const runtime = (options.runtimeFactory ?? nativeRuntime)(root);
    stage = 'portable-check';
    try {
      lstatSync(runtime.portable);
      throw new Error('PORTABLE_DATA_EXISTS');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    stage = 'fixture-allocation';
    fixture = makeOwnerFixture(sessionId, options.fixtureHooks);
    options.observeFixture?.(fixture);
    stage = 'socket-bounds';
    const manifest = JSON.parse(readFileSync(join(upstream, 'package.json'), 'utf8'));
    checkSocketBounds(fixture.paths.u, manifest.version);
    stage = 'environment';
    const env = isolatedEnvironment(evidence, fixture.paths.g, parentEnvironment, {
      home: fixture.paths.home,
      xdg: fixture.paths.xdg,
    });
    routing = environmentKeys.map((key) => ({ key, childPresent: Object.hasOwn(env, key) }));
    stage = 'source-preflight';
    options.trace?.('before-source-preflight');
    sourcePreflight = readOnlySourceCheck(env, options.observeSourceGit);
    assertPreparedArtifacts(runtime, sourcePreflight);
    sourcePreflightPassed = true;
    options.trace?.('source-preflight-complete');
    workspacePath = realpathSync(fixture.paths.w);
    stage = 'settings';
    mkdirSync(join(fixture.paths.u, 'User'), { mode: 0o700 });
    chmodSync(join(fixture.paths.u, 'User'), 0o700);
    (options.writeSettings ?? writeFileSync)(
      join(fixture.paths.u, 'User/settings.json'),
      JSON.stringify({
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'extensions.autoCheckUpdates': false,
        'extensions.autoUpdate': false,
        'chat.disableAIFeatures': true,
        'security.workspace.trust.enabled': false,
        'git.enabled': true,
        'git.loggingLevel': 'trace',
        'git.path': fixedGit,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    stage = 'git-fixture';
    options.trace?.('fixture-git');
    (options.runFixtureGit ?? gitFixture)(fixture.paths.w, fixture.paths.g, env);
    stage = 'native-launch';
    options.trace?.('native-launch');
    host = startOwnedHost({
      runtime,
      fixture,
      evidence,
      env,
      launch: options.launch,
      timeoutMs: options.timeoutMs,
      probes: options.probes,
    });
    stage = 'native-completion';
    const state = await host.completion;
    if (state.status !== 'pass' || state.result?.status !== 'pass')
      throw new Error('EXTENSION_HOST_FAILED');
  } catch (error) {
    failure = safeCode(error);
    failureStage = stage;
    allocationLeftovers = error.leftovers ?? [];
    cleanupError = error.cleanupError ?? cleanupError;
  } finally {
    try {
      if (host && !host.state.finalized) {
        stage = 'finalization';
        try {
          await host.terminate();
        } catch {
          failure ??= 'FINALIZATION_FAILED';
          failureStage ??= stage;
        }
      }
      stage = 'fixture-cleanup';
      try {
        if (fixture) cleanup = removeFixture(fixture, host, options.fixtureCleanup);
        else if (allocationLeftovers.length)
          cleanup = {
            disposition: cleanupError ? 'cleanup-failed' : 'preserved',
            code: cleanupError?.code,
            paths: allocationLeftovers,
          };
      } catch (error) {
        cleanup = {
          disposition: 'cleanup-failed',
          code: safeCode(error),
          paths: fixture
            ? [fixture.fixtureRoot, `UNKNOWN:${fixture.fixtureRoot}:OBSERVATION_FAILED`]
            : allocationLeftovers,
        };
        cleanupError = cleanupError
          ? { ...cleanupError, finalCleanup: { stage, code: cleanup.code, paths: cleanup.paths } }
          : { stage, code: cleanup.code, paths: cleanup.paths };
        failure ??= 'FIXTURE_CLEANUP_FAILED';
        failureStage ??= stage;
      }
      if (cleanup.disposition === 'cleanup-failed') {
        cleanupError = cleanupError
          ? { ...cleanupError, finalCleanup: { stage, code: cleanup.code, paths: cleanup.paths } }
          : { stage, code: cleanup.code, paths: cleanup.paths };
        failure ??= 'FIXTURE_CLEANUP_FAILED';
        failureStage ??= stage;
      } else if (cleanup.disposition !== 'removed') {
        failure ??= 'OWNED_FIXTURE_PRESERVED';
        failureStage ??= stage;
      }
      if (host?.state.finalized && host.state.cleanup?.confirmedClosed !== true) {
        try {
          host.child.unref();
          childUnrefCompleted = true;
        } catch {
          failure ??= 'CHILD_UNREF_FAILED';
          failureStage ??= 'runner-result';
        }
      }
      const summary = {
        status: failure ? 'fail' : 'pass',
        reason: failure,
        stage: failureStage,
        sessionId,
        resultPath,
        sourcePreflight: sourcePreflightPassed
          ? 'passed'
          : sourcePreflight
            ? 'source-checked'
            : 'not-run',
        sourceHead: sourcePreflight?.head ?? null,
        sourceDigest: sourcePreflight?.sourceDigest ?? null,
        workspacePath: workspacePath ?? null,
        hostStatus: host?.state.status ?? null,
        hostPid: host?.state.pid ?? null,
        timedOut: host?.state.timedOut ?? false,
        ownership: host?.state.ownership ?? null,
        confirmedClosed: host?.state.cleanup.confirmedClosed ?? null,
        childMayRemain: Boolean(host?.state.pid && host.state.cleanup?.confirmedClosed !== true),
        cleanup,
        cleanupError,
        routing,
      };
      try {
        (options.writeRunnerResult ?? writeFileSync)(
          join(evidence, 'runner-result.json'),
          JSON.stringify(summary, null, 2),
          { flag: 'wx', mode: 0o600 },
        );
      } catch (error) {
        runnerResultFailure = safeCode(error);
        failure ??= runnerResultFailure;
        failureStage ??= 'runner-result';
      }
      if (!failure) {
        try {
          (options.writeOutput ?? ((message) => process.stdout.write(message)))(
            `Extension host passed: ${resultPath}\n`,
          );
        } catch {}
      }
    } finally {
      if (
        host?.state.finalized &&
        host.state.cleanup?.confirmedClosed !== true &&
        !childUnrefCompleted
      ) {
        try {
          host.child.unref();
          childUnrefCompleted = true;
        } catch {
          failure ??= 'CHILD_UNREF_FAILED';
          failureStage ??= 'runner-result';
        }
      }
    }
  }
  if (failure)
    throw Object.assign(new Error('Extension host failed'), {
      code: failure,
      stage: failureStage,
      evidence,
      runnerResultFailure,
      childMayRemain: Boolean(host?.state.pid && host.state.cleanup?.confirmedClosed !== true),
    });
  return { evidence, resultPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runExtensionHost();
  } catch (error) {
    const summaryFailure = error.runnerResultFailure
      ? `; runner-result write failed (${error.runnerResultFailure})`
      : '';
    const liveChild =
      error.runnerResultFailure && error.childMayRemain
        ? '; fixture was preserved and an owned child may still be running'
        : '';
    process.stderr.write(
      `Extension host failed at ${error.stage ?? 'runner'} (${safeCode(error)})${summaryFailure}${liveChild}\n`,
    );
    process.exitCode = 1;
  }
}
