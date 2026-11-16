import * as fs from 'node:fs';
import * as os from 'node:os';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { evidenceSession } from './componentInventory.mjs';
import { createFiles, digest, within } from './componentInventoryFiles.mjs';
import { strictGit, gitEnvironment, gitPrefix } from './componentInventoryGit.mjs';
import { check, root, upstream } from './upstream.mjs';

export const helperPath = resolve(root, 'crates/devloom-sidecar/target/debug/devloom-sidecar');
const requiredPaths = [
  'scripts/runRpcBenchmark.mjs',
  'scripts/rpcBenchmark.mjs',
  'scripts/componentInventory.mjs',
  'scripts/componentInventoryFiles.mjs',
  'scripts/componentInventoryGit.mjs',
  'scripts/componentInventoryCollectors.mjs',
  'scripts/upstream.mjs',
  'scripts/patchUpstream.mjs',
  'extensions/devloom-bootstrap/src/bridgeClient.ts',
  'extensions/devloom-bootstrap/src/protocol.ts',
  'extensions/devloom-bootstrap/src/framing.ts',
  'dist/extensions/devloom-bootstrap/src/bridgeClient.js',
  'dist/extensions/devloom-bootstrap/src/protocol.js',
  'dist/extensions/devloom-bootstrap/src/framing.js',
  'crates/devloom-sidecar/src/main.rs',
  'crates/devloom-sidecar/src/server.rs',
  'crates/devloom-sidecar/src/framing.rs',
  'crates/devloom-sidecar/Cargo.toml',
  'crates/devloom-sidecar/Cargo.lock',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'rust-toolchain.toml',
  'upstream.lock.json',
  'crates/devloom-sidecar/target/debug/devloom-sidecar',
];
const toolEnvironment = {
  PATH: `${root}/.tools/node-v24.22.1-darwin-arm64/bin:${root}/.tools/cargo/bin:/usr/bin:/bin`,
  CARGO_HOME: resolve(root, '.tools/cargo'),
  RUSTUP_HOME: resolve(root, '.tools/rustup'),
  RUSTUP_AUTO_INSTALL: '0',
  CARGO_NET_OFFLINE: 'true',
  LANG: 'C',
  LC_ALL: 'C',
};
const command = (executable, args, options = {}) =>
  execFileSync(executable, args, {
    cwd: root,
    env: toolEnvironment,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
    maxBuffer: 33554432,
    ...options,
  });
export function snapshotFiles(repository = root, paths = requiredPaths) {
  const files = createFiles(repository);
  return paths.map((path) => {
    const absolute = resolve(repository, path);
    const file = files.read(absolute, 'binary');
    if (!file || !within(repository, absolute)) throw new Error('required-file-unavailable');
    return { path, sha256: file.sha256, sizeBytes: fs.statSync(absolute).size };
  });
}
export function verifySnapshot(before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('provenance-drift');
}
export function preflight() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('unsupported-host');
  const fileHashes = snapshotFiles();
  const lock = JSON.parse(fs.readFileSync(resolve(root, 'upstream.lock.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(resolve(root, 'package.json'), 'utf8'));
  const toolchain = fs.readFileSync(resolve(root, 'rust-toolchain.toml'), 'utf8');
  const compilerPath = fs.realpathSync(resolve(root, 'node_modules/typescript/package.json'));
  if (!within(root, compilerPath)) throw new Error('source-provenance-failed');
  const compiler = createFiles(root).json(compilerPath);
  if (!compiler) throw new Error('source-provenance-failed');
  fileHashes.push({
    path: relative(root, compilerPath),
    sha256: compiler.sha256,
    sizeBytes: compiler.bytes.length,
  });
  const cargo = command(resolve(root, '.tools/cargo/bin/cargo'), ['--version']).trim();
  const rustc = command(resolve(root, '.tools/cargo/bin/rustc'), ['--version']).trim();
  if (
    process.version !== `v${lock.node}` ||
    lock.node !== '24.22.1' ||
    lock.rust !== '1.100.0' ||
    !toolchain.includes('channel = "1.100.0"') ||
    !cargo.startsWith('cargo 1.100.0 ') ||
    !rustc.startsWith('rustc 1.100.0 ') ||
    manifest.packageManager !== lock.packageManager ||
    manifest.devDependencies.typescript !== 'npm:@typescript/typescript6@6.0.2' ||
    compiler.value.version !== '6.0.2'
  )
    throw new Error('toolchain-mismatch');
  let source;
  const runGit = strictGit(root, upstream);
  try {
    source = check({ readOnly: true, runGit });
  } catch {
    throw new Error('source-provenance-failed');
  }
  const git = (args) =>
    command('/opt/homebrew/bin/git', [...gitPrefix, ...args], {
      env: { ...gitEnvironment },
    });
  const sourceHead = git(['rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceHead)) throw new Error('source-provenance-failed');
  const sourceDirty =
    git(['status', '--porcelain=v1', '-z', '--untracked-files=normal']).length > 0;
  return {
    platform: process.platform,
    architecture: process.arch,
    osRelease: os.release(),
    cpuModel: os.cpus()[0]?.model ?? 'unavailable',
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    node: process.version,
    v8: process.versions.v8,
    cargo,
    rustc,
    packageVersion: manifest.version,
    packageManager: manifest.packageManager,
    compilerVersion: compiler.value.version,
    compilerSha256: compiler.sha256,
    sourceHead,
    sourceDirty,
    source,
    identity: runGit.identity,
    fileHashes,
    helper: {
      path: helperPath,
      ...fileHashes.find((file) => resolve(root, file.path) === helperPath),
      requestedProfile: 'debug',
      compilerAndProfileOverrides: 'unobserved',
      buildProvenance: 'observed-local-bytes',
    },
    preflightCommands: {
      shell: false,
      timeoutMs: 30000,
      maxBufferBytes: 33554432,
      tools: [
        'fixed-cargo --version',
        'fixed-rustc --version',
        'strict-read-only-git',
        'source-git rev-parse HEAD',
        'source-git status --porcelain=v1 -z --untracked-files=normal',
      ],
    },
  };
}
export function parseRss(stdout) {
  if (!/^\s*\d+\s*$/u.test(stdout)) throw new Error('invalid-rss');
  const originalValue = Number(stdout.trim());
  if (
    !Number.isSafeInteger(originalValue) ||
    originalValue <= 0 ||
    !Number.isSafeInteger(originalValue * 1024)
  )
    throw new Error('invalid-rss');
  return { originalValue, originalUnit: '1024-byte-units', bytes: originalValue * 1024 };
}
export function memoryBoundary({ phase, repetition, client }, probe = command) {
  const at = new Date().toISOString();
  const values = [
    {
      phase,
      repetition,
      at,
      process: 'runner',
      pid: process.pid,
      available: true,
      bytes: process.memoryUsage.rss(),
      method: 'process.memoryUsage.rss',
      unit: 'bytes',
      scope: 'shared-runner-with-retained-samples',
    },
  ];
  if (!client || client.state !== 'ready') return values;
  const pid = client.pid,
    generation = client.generation;
  const sample = {
    phase,
    repetition,
    at,
    process: 'helper',
    pid,
    generation,
    method: '/bin/ps -o rss= -p owned-pid',
    unit: 'bytes',
    timeoutMs: 2000,
    maxBufferBytes: 4096,
    scope: 'single-helper-process-boundary',
  };
  try {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid-rss');
    const rss = parseRss(
      probe('/bin/ps', ['-o', 'rss=', '-p', String(pid)], {
        timeout: 2000,
        maxBuffer: 4096,
      }),
    );
    if (client.pid !== pid || client.generation !== generation || client.state !== 'ready')
      throw new Error('invalid-rss');
    values.push({ ...sample, available: true, ...rss });
  } catch {
    values.push({ ...sample, available: false, reason: 'owned-rss-unavailable-or-replaced' });
  }
  return values;
}
export async function main(args = process.argv.slice(2), environment = process.env, adapters = {}) {
  let session, rawFd, rawPath, benchmark;
  let rawCount = 0;
  const result = {
    schemaVersion: 1,
    experiment: 'rpc-echo-baseline',
    outcome: 'failed',
    stage: 'arguments',
    session: { createdAt: new Date().toISOString() },
    cells: [],
    summaries: [],
    lifecycle: [],
    memory: [],
    cleanup: { attempted: false, completed: false, clientsStopped: 0 },
  };
  const record = (value) => {
    fs.writeSync(rawFd, `${JSON.stringify(value)}\n`);
    rawCount++;
  };
  try {
    if (args.length) throw new Error('unsupported-cli-argument');
    result.stage = 'evidence';
    session = evidenceSession(environment.DEVLOOM_EVIDENCE_DIR, adapters.repository ?? root);
    rawPath = resolve(session, 'raw.jsonl');
    rawFd = fs.openSync(rawPath, 'wx', 0o600);
    result.session.rawPath = rawPath;
    result.stage = 'preflight';
    record({
      kind: 'session',
      experiment: result.experiment,
      evidenceKind: adapters.evidenceKind ?? 'actual-local-run',
    });
    result.provenance = (adapters.preflight ?? preflight)();
    benchmark = await import('./rpcBenchmark.mjs');
    Object.assign(result, {
      config: benchmark.config,
      configDigest: benchmark.configDigest,
      inputs: benchmark.inputIdentities,
      limitations: benchmark.limitations,
    });
    record({
      kind: 'context',
      config: result.config,
      configDigest: result.configDigest,
      provenance: result.provenance,
      inputs: result.inputs,
    });
    const { BridgeClient } =
      await import('../dist/extensions/devloom-bootstrap/src/bridgeClient.js');
    await (adapters.experiment ?? benchmark.runExperiment)({
      createClient: () => new BridgeClient(helperPath),
      result,
      record,
      boundary: adapters.boundary ?? memoryBoundary,
    });
    result.stage = 'final-provenance';
    (
      adapters.verify ??
      (() =>
        verifySnapshot(
          result.provenance.fileHashes,
          snapshotFiles(
            root,
            result.provenance.fileHashes.map((file) => file.path),
          ),
        ))
    )();
    if (!result.cleanup.completed || result.cleanup.errorCode) throw new Error('invalid-lifecycle');
    result.outcome = 'passed';
    result.stage = 'complete';
  } catch (error) {
    const earlyCodes = [
      'unsupported-cli-argument',
      'evidence-parent-required',
      'output-inside-repository',
      'unsupported-host',
      'required-file-unavailable',
      'source-provenance-failed',
      'toolchain-mismatch',
      'provenance-drift',
    ];
    result.errorCode =
      benchmark?.safeError(error) ??
      (earlyCodes.includes(error?.message) ? error.message : 'benchmark-failed');
  } finally {
    result.completedCellCount = result.cells.length;
    result.memoryCoverage =
      result.memory.some((item) => item.process === 'helper') &&
      result.memory.every((item) => item.available)
        ? 'complete'
        : 'incomplete';
    result.session.finishedAt = new Date().toISOString();
    if (rawFd !== undefined) {
      try {
        record({
          kind: 'final',
          outcome: result.outcome,
          stage: result.stage,
          errorCode: result.errorCode,
          cleanup: result.cleanup,
        });
        fs.fsyncSync(rawFd);
      } finally {
        fs.closeSync(rawFd);
      }
      result.session.rawSha256 = digest(fs.readFileSync(rawPath));
      result.session.rawRecordCount = rawCount;
      const reportPath = resolve(session, 'benchmark.json');
      fs.writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      (adapters.stdout ?? process.stdout).write(
        `${JSON.stringify({
          path: reportPath,
          outcome: result.outcome,
          configDigest: result.configDigest,
        })}\n`,
      );
    } else
      (adapters.stderr ?? process.stderr).write(
        `${JSON.stringify({ errorCode: result.errorCode })}\n`,
      );
  }
  return result.outcome === 'passed' ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch {
    process.stderr.write('{"errorCode":"evidence-write-failed"}\n');
    process.exitCode = 1;
  }
}
