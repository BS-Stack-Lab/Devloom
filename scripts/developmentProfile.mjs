import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const markerName = '.devloom-owner.json';
const validId = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const initialSettings = {
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoCheckUpdates': false,
  'extensions.autoUpdate': false,
  'chat.disableAIFeatures': true,
};

export function selectDevelopmentProfile(args, env = process.env, cwd = process.cwd()) {
  const input = [...args];
  if (input[0] === '--') input.shift();
  let selected;
  let workspace;
  for (let index = 0; index < input.length; index++) {
    const arg = input[index];
    if (arg === '--dev-profile' || arg.startsWith('--dev-profile=')) {
      if (selected !== undefined) throw new Error('Duplicate --dev-profile selector');
      selected = arg === '--dev-profile' ? input[++index] : arg.slice(14);
      if (selected === undefined || !validId.test(selected))
        throw new Error('Invalid development profile ID');
    } else {
      if (arg.startsWith('-')) throw new Error('Unknown development start option');
      if (workspace !== undefined) throw new Error('Use at most one workspace directory');
      workspace = resolve(cwd, arg);
      if (!lstatSync(workspace).isDirectory()) throw new Error('Workspace must be a directory');
    }
  }
  const id = selected ?? env.DEVLOOM_PROFILE ?? 'default';
  if (!validId.test(id)) throw new Error('Invalid development profile ID');
  return { id, workspace };
}

function stat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function verifyNode(path, directory, privateFile = false) {
  const value = lstatSync(path);
  if (
    value.isSymbolicLink() ||
    (directory ? !value.isDirectory() : !value.isFile()) ||
    value.uid !== process.getuid() ||
    (value.mode & (privateFile ? 0o077 : 0o022)) !== 0
  )
    throw new Error('Unsafe development profile path; inspect manually and choose another ID');
  return value;
}

function readMarker(path, expected) {
  let fd;
  try {
    verifyNode(path, false, true);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const value = fstatSync(fd);
    if (
      !value.isFile() ||
      value.uid !== process.getuid() ||
      value.mode & 0o077 ||
      value.size > 4096
    )
      throw new Error('Unsafe development profile marker');
    const bytes = Buffer.alloc(4097);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > 4096) throw new Error('Oversized development profile marker');
    const actual = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    if (
      Object.keys(actual).sort().join(',') !== Object.keys(expected).sort().join(',') ||
      Object.entries(expected).some(([key, content]) => actual[key] !== content)
    )
      throw new Error('Development profile ownership mismatch');
  } catch {
    throw new Error('Incomplete or invalid development profile; inspect manually or retry safely');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function createDirectory(path) {
  try {
    mkdirSync(path, { mode: 0o700 });
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    verifyNode(path, true);
    return false;
  }
}

function publishMarker(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
}

export function developmentLocation(repository, id) {
  if (!validId.test(id)) throw new Error('Invalid development profile ID');
  const version = '1.146.0';
  const lock = JSON.parse(readFileSync(new URL('../upstream.lock.json', import.meta.url), 'utf8'));
  if (lock.version !== version) throw new Error('Pinned development IPC version mismatch');
  const canonicalRoot = realpathSync(repository);
  const token = createHash('sha256').update(id, 'ascii').digest('hex').slice(0, 16);
  const tools = join(canonicalRoot, '.tools');
  const namespace = join(tools, 'dp');
  const path = join(namespace, token);
  const userData = join(path, 'u');
  const extensions = join(path, 'extensions');
  const ipc = ['main', 'shared'].map((type) => {
    const socket = join(userData, `${version.slice(0, 4)}-${type.slice(0, 6)}.sock`);
    return { type, socket, bytes: Buffer.byteLength(socket, 'utf8') };
  });
  if (ipc.some(({ bytes }) => bytes >= 103))
    throw new Error(
      'macOS IPC pathname must be below 103 UTF-8 bytes; use a shorter checkout path',
    );
  return { canonicalRoot, token, tools, namespace, path, userData, extensions, ipc };
}

export function developmentProfile(repository, id) {
  const location = developmentLocation(repository, id);
  const { canonicalRoot, tools, namespace, path, userData, extensions } = location;
  createDirectory(tools);
  verifyNode(tools, true);
  const rootMarker = { schema: 1, kind: 'development-profile-root', root: canonicalRoot };
  if (createDirectory(namespace)) publishMarker(join(namespace, markerName), rootMarker);
  try {
    readMarker(join(namespace, markerName), rootMarker);
  } catch {
    throw new Error('Incomplete or foreign profile root; inspect manually or retry safely');
  }
  const user = join(userData, 'User');
  const settings = join(user, 'settings.json');
  const marker = {
    schema: 1,
    kind: 'development-profile',
    root: canonicalRoot,
    id,
    userData: 'u',
    extensions: 'extensions',
  };
  const created = createDirectory(path);
  if (created) {
    for (const dir of [userData, extensions, user]) mkdirSync(dir, { mode: 0o700 });
    writeFileSync(settings, `${JSON.stringify(initialSettings, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    publishMarker(join(path, markerName), marker);
  }
  readMarker(join(path, markerName), marker);
  for (const dir of [namespace, path, userData, user, extensions]) verifyNode(dir, true);
  if (stat(settings)) verifyNode(settings, false);
  return { ...location, id, created, settings, marker };
}

export function developmentArguments(repository, profile, workspace) {
  return [
    `--extensionDevelopmentPath=${resolve(repository, 'extensions/devloom-bootstrap')}`,
    `--user-data-dir=${profile.userData}`,
    `--extensions-dir=${profile.extensions}`,
    '--new-window',
    '--disable-telemetry',
    '--disable-updates',
    ...[
      'GitHub.copilot-chat',
      'GitHub.copilot',
      'vscode.github-authentication',
      'vscode.microsoft-authentication',
    ].map((id) => `--disable-extension=${id}`),
    ...(workspace ? [workspace] : []),
  ];
}
