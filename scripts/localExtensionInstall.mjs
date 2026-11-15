import { spawn, execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { developmentArguments, developmentProfile } from './developmentProfile.mjs';
import {
  assertArtifactIdentity,
  boundedRead,
  hash,
  safeNode,
  verifyInstalled,
} from './localExtensionArtifact.mjs';

export const routingKeys = [
  'VSCODE_IPC_HOOK_CLI',
  'VSCODE_CLIENT_COMMAND',
  'VSCODE_CLIENT_COMMAND_CWD',
  'VSCODE_CLI_AUTHORITY',
  'VSCODE_PORTABLE',
  'VSCODE_APPDATA',
  'VSCODE_CWD',
  'VSCODE_IPC_HOOK',
  'VSCODE_PID',
  'ELECTRON_RUN_AS_NODE',
];
export function localEnvironment(root, inherited = process.env) {
  const env = { ...inherited };
  for (const key of routingKeys) delete env[key];
  return { ...env, DEVLOOM_APP_ROOT: root, VSCODE_DEV: '1', VSCODE_SKIP_PRELAUNCH: '1' };
}
export function assertInactive(profile) {
  for (const { socket } of profile.ipc)
    if (existsSync(socket))
      throw new Error(
        'Profile is active or has an unresolved native IPC socket; quit cleanly and inspect before installation',
      );
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,args='], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (
    rows
      .split('\n')
      .some(
        (line) =>
          line.includes(`--user-data-dir=${profile.userData}`) &&
          !line.trim().startsWith(`${process.pid} `),
      )
  )
    throw new Error('Profile process remains active; installation requires a clean quit');
}
export function nativeRuntime(root) {
  root = realpathSync(root);
  const pinned = join(root, 'vendor/code-oss');
  safeNode(pinned, true);
  const product = JSON.parse(boundedRead(join(pinned, 'product.json')));
  const executable =
    process.platform === 'darwin'
      ? join(
          pinned,
          '.build/electron',
          `${product.nameLong}.app`,
          'Contents/MacOS',
          product.nameShort,
        )
      : join(pinned, '.build/electron', product.applicationName);
  const entry = join(pinned, 'out/cli.js');
  safeNode(entry);
  const actual = realpathSync(executable);
  safeNode(actual);
  if (actual !== executable) throw new Error('Unexpected native Electron executable alias');
  return {
    executable,
    entry,
    cwd: realpathSync(pinned),
    portable:
      process.platform === 'darwin'
        ? resolve(pinned, `../devloom-portable-data`)
        : join(pinned, 'data'),
  };
}
export function assertNativeInvocation(result, expected) {
  for (const key of ['executable', 'cwd'])
    if (result[key] !== expected[key]) throw new Error(`Native CLI ${key} mismatch`);
  if (
    JSON.stringify(result.args) !== JSON.stringify(expected.args) ||
    !Number.isSafeInteger(result.pid) ||
    result.pid < 2
  )
    throw new Error('Native CLI invocation identity mismatch');
  if (
    result.environment?.ELECTRON_RUN_AS_NODE !== '1' ||
    result.environment?.NODE_ENV !== 'development' ||
    result.environment?.VSCODE_DEV !== '1'
  )
    throw new Error('Native CLI child environment mismatch');
  if (
    routingKeys
      .filter((key) => key !== 'ELECTRON_RUN_AS_NODE')
      .some((key) => result.environment?.[key] !== undefined)
  )
    throw new Error('Inherited native CLI routing field');
}
export function nativeCLI(executable, args, options) {
  return new Promise((resolveChild, reject) => {
    const child = spawn(executable, args, {
      ...options,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let failure;
    let kill;
    let observedCwd;
    let observedProcess;
    let cwdObservationError;
    child.once('spawn', () => {
      try {
        observedProcess = execFileSync(
          '/bin/ps',
          ['-p', String(child.pid), '-o', 'pid=,ppid=,pgid=,comm=,args='],
          { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 },
        ).trim();
        const value = execFileSync(
          '/usr/sbin/lsof',
          ['-a', '-p', String(child.pid), '-d', 'cwd', '-Fn'],
          { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 },
        );
        observedCwd = value
          .split('\n')
          .find((line) => line.startsWith('n'))
          ?.slice(1);
        if (observedCwd !== options.cwd) stop('Native CLI observed cwd mismatch');
      } catch (error) {
        cwdObservationError = error.message;
        stop('Native CLI cwd could not be observed');
      }
    });
    const stop = (message) => {
      if (failure) return;
      failure = new Error(message);
      kill = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }, 2000);
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') failure = error;
      }
    };
    const timer = setTimeout(
      () => stop('Native extension CLI timeout'),
      Math.min(options.timeoutMs ?? 45000, 45000),
    );
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (bytes) => {
        if (output.length + bytes.length > 1024 * 1024) stop('Oversized native CLI output');
        else output += bytes.toString();
      });
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(kill);
      const result = {
        code,
        signal,
        output,
        pid: child.pid,
        executable,
        args,
        cwd: options.cwd,
        environment: Object.fromEntries(
          [...routingKeys, 'NODE_ENV', 'VSCODE_DEV', 'DEVLOOM_APP_ROOT'].map((key) => [
            key,
            options.env[key],
          ]),
        ),
        routing:
          options.routing ??
          routingKeys.map((key) => ({ key, childPresent: Object.hasOwn(options.env, key) })),
        observedCwd,
        observedProcess,
        cwdObservationError,
      };
      if (failure || code !== 0)
        reject(
          Object.assign(failure ?? new Error(`Native extension CLI failed (${code})`), { result }),
        );
      else resolveChild(result);
    });
  });
}
function registered(profile, artifact) {
  const registry = join(profile.extensions, 'extensions.json');
  if (!existsSync(registry)) return [];
  const bytes = boundedRead(registry);
  const entries = JSON.parse(bytes);
  if (!Array.isArray(entries) || entries.length > 1000)
    throw new Error('Invalid native extension registry');
  return entries.filter(
    (entry) => entry.identifier?.id?.toLowerCase() === artifact.id.toLowerCase(),
  );
}
function candidates(profile, artifact) {
  const names = readdirSync(profile.extensions);
  if (names.length > 1000) throw new Error('Extension candidate bound reached');
  return names
    .filter((name) => {
      if (name.toLowerCase().startsWith(`${artifact.id.toLowerCase()}-`)) return true;
      const path = join(profile.extensions, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('Unsafe extension destination candidate');
      if (!stat.isDirectory() || !existsSync(join(path, 'package.json'))) return false;
      const manifest = JSON.parse(boundedRead(join(path, 'package.json')));
      return `${manifest.publisher}.${manifest.name}`.toLowerCase() === artifact.id.toLowerCase();
    })
    .map((name) => join(profile.extensions, name));
}

function location(entry) {
  if (entry.location?.scheme !== 'file' || entry.location?.authority)
    throw new Error('Foreign native extension registry location');
  return entry.location.path;
}
export async function ensureLocalExtension(root, profile, artifact, options = {}) {
  root = realpathSync(root);
  assertArtifactIdentity(artifact, root);
  const runtime = nativeRuntime(root);
  const portable = runtime.portable;
  if (existsSync(portable))
    throw new Error(
      'Native portable data would override the owned profile; preserve and inspect it',
    );
  const owned = developmentProfile(root, profile.id);
  if (['path', 'userData', 'extensions'].some((key) => profile[key] !== owned[key]))
    throw new Error('Profile installation routing mismatch');
  const lock = join(profile.path, '.local-install-lock');
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        'Extension preparation locked; retry after completion or inspect a pending installation',
      );
    throw error;
  }
  const owner = randomUUID();
  const lockIdentity = lstatSync(lock);
  const ownerRecord = JSON.stringify({
    owner,
    root,
    profile: profile.id,
    artifact: artifact.digest,
  });
  writeFileSync(join(lock, 'owner.json'), ownerRecord, { flag: 'wx', mode: 0o600 });
  const receiptPath = join(profile.path, `.receipt-${artifact.id}.json`);
  const pendingName = `.pending-${artifact.id}.json`;
  const pending = join(profile.path, pendingName);
  const log = join(artifact.stage, `native-${randomUUID()}.json`);
  let complete = false;
  let mutationStarted = false;
  let pendingObserved = false;
  const calls = [];
  const cli = options.cli ?? nativeCLI;
  const common = developmentArguments(root, profile).filter(
    (arg) => !arg.startsWith('--disable-extension='),
  );
  const invoke = async (args) => {
    try {
      const invocation = {
        executable: runtime.executable,
        args: [runtime.entry, '.', ...common, ...args],
        cwd: runtime.cwd,
      };
      const env = {
        ...localEnvironment(root, options.env),
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'development',
      };
      const result = await cli(invocation.executable, invocation.args, {
        cwd: invocation.cwd,
        env,
        routing: routingKeys.map((key) => ({
          key,
          inheritedPresent: Object.hasOwn(options.env ?? process.env, key),
          childPresent: Object.hasOwn(env, key),
        })),
      });
      calls.push(result);
      assertNativeInvocation(result, invocation);
      if (result.observedCwd !== invocation.cwd) throw new Error('Native CLI actual cwd mismatch');
      return result;
    } catch (error) {
      calls.push(error.result ?? { error: String(error) });
      throw error;
    }
  };
  try {
    if (readdirSync(profile.path).includes(pendingName)) {
      pendingObserved = true;
      throw new Error('Pending native installation requires manual inspection');
    }
    const receipt = existsSync(receiptPath) ? JSON.parse(boundedRead(receiptPath)) : undefined;
    if (
      receipt &&
      receipt.version
        .split('.')
        .reduce(
          (order, value, index) =>
            order || Math.sign(Number(value) - Number(artifact.version.split('.')[index])),
          0,
        ) > 0
    )
      throw new Error('Owned extension downgrade is refused');
    if (receipt) {
      assertArtifactIdentity(receipt.artifact, root);
      if (
        receipt.digest !== receipt.artifact.digest ||
        receipt.id !== receipt.artifact.id ||
        receipt.version !== receipt.artifact.version
      )
        throw new Error('Owned receipt artifact identity mismatch');
    }
    const retired = receipt?.retired ?? [];
    if (!Array.isArray(retired) || retired.length > 16)
      throw new Error('Invalid retired owned payload receipt');
    if (receipt && receipt.version !== artifact.version && retired.length >= 16)
      throw new Error('Owned prior-version receipt bound reached; inspect manually');
    for (const previous of retired) {
      assertArtifactIdentity(previous.artifact, root);
      if (previous.artifact.id !== previous.id || previous.artifact.version !== previous.version)
        throw new Error('Retired artifact identity mismatch');
      if (
        previous.id !== artifact.id ||
        previous.root !== root ||
        !/^\d+\.\d+\.\d+$/.test(previous.version) ||
        previous.path !== join(profile.extensions, `${artifact.id}-${previous.version}`)
      )
        throw new Error('Invalid retired owned payload');
      if (existsSync(previous.path)) verifyInstalled(previous.path, previous.artifact);
    }
    const entries = registered(profile, artifact);
    const paths = candidates(profile, artifact);
    if (
      receipt &&
      (receipt.schema !== 1 ||
        receipt.root !== root ||
        receipt.profile !== profile.id ||
        receipt.profilePath !== profile.path ||
        receipt.id !== artifact.id ||
        !/^\d+\.\d+\.\d+$/.test(receipt.version) ||
        receipt.path !== join(profile.extensions, `${artifact.id}-${receipt.version}`))
    )
      throw new Error('Invalid owned installation receipt');
    if (!receipt && (entries.length || paths.length))
      throw new Error('Unknown own-ID extension collision; existing files preserved');
    if (receipt) {
      if (
        entries.length > 1 ||
        paths.some(
          (path) => path !== receipt.path && !retired.some((previous) => previous.path === path),
        ) ||
        entries.some(
          (entry) => location(entry) !== receipt.path || entry.version !== receipt.version,
        )
      )
        throw new Error('Conflicting own-ID native registration');
      if (existsSync(receipt.path)) verifyInstalled(receipt.path, receipt.artifact);
      if (receipt.digest === artifact.digest && entries.length === 1 && existsSync(receipt.path)) {
        verifyInstalled(receipt.path, artifact);
        complete = true;
        return { status: 'reused', receipt, calls, log };
      }
    }
    (options.inactive ?? assertInactive)(profile);
    mutationStarted = true;
    writeFileSync(
      pending,
      JSON.stringify({
        owner,
        root,
        profile: profile.id,
        digest: artifact.digest,
        archive: artifact.archive,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    if (hash(boundedRead(artifact.archive)) !== artifact.archiveSha256)
      throw new Error('Local archive changed before native installation');
    await invoke([
      `--install-extension=${artifact.archive}`,
      '--do-not-include-pack-dependencies',
      '--do-not-sync',
      ...(receipt ? ['--force'] : []),
    ]);
    const listed = await invoke(['--list-extensions', '--show-versions']);
    if (!listed.output.split(/\r?\n/).includes(`${artifact.id}@${artifact.version}`))
      throw new Error('Native CLI did not list the expected local extension');
    const located = await invoke([`--locate-extension=${artifact.id}`]);
    const after = registered(profile, artifact);
    if (after.length !== 1 || after[0].version !== artifact.version)
      throw new Error('Native registry did not register expected local extension');
    const path = location(after[0]);
    if (
      path !== join(profile.extensions, `${artifact.id}-${artifact.version}`) ||
      dirname(path) !== profile.extensions ||
      candidates(profile, artifact).some(
        (candidate) =>
          candidate !== path &&
          candidate !== receipt?.path &&
          !retired.some((previous) => previous.path === candidate),
      )
    )
      throw new Error('Unexpected native installation location');
    if (!located.output.split(/\r?\n/).includes(path))
      throw new Error('Native CLI location does not match registered payload');
    verifyInstalled(path, artifact);
    if (receipt && path !== receipt.path && existsSync(receipt.path))
      verifyInstalled(receipt.path, receipt.artifact);
    const receiptValue = {
      schema: 1,
      root,
      profile: profile.id,
      profilePath: profile.path,
      id: artifact.id,
      version: artifact.version,
      path,
      digest: artifact.digest,
      artifact,
      retired: [
        ...retired,
        ...(receipt && receipt.version !== artifact.version
          ? [
              {
                id: receipt.id,
                root: receipt.root,
                version: receipt.version,
                path: receipt.path,
                artifact: receipt.artifact,
              },
            ]
          : []),
      ],
      installed: Date.now(),
    };
    const temporary = `${receiptPath}.${owner}`;
    writeFileSync(temporary, JSON.stringify(receiptValue), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, receiptPath);
    rmSync(pending);
    complete = true;
    return { status: receipt ? 'updated' : 'installed', receipt: receiptValue, calls, log };
  } finally {
    writeFileSync(
      log,
      JSON.stringify({ owner, complete, mutationStarted, pendingObserved, calls }),
      { flag: 'wx', mode: 0o600 },
    );
    if (
      complete ||
      (!mutationStarted && !pendingObserved && !readdirSync(profile.path).includes(pendingName))
    ) {
      const currentLock = safeNode(lock, true);
      if (
        currentLock.dev !== lockIdentity.dev ||
        currentLock.ino !== lockIdentity.ino ||
        boundedRead(join(lock, 'owner.json')).toString() !== ownerRecord
      )
        throw new Error('Install lock ownership changed');
      rmSync(lock, { recursive: true });
    }
  }
}
