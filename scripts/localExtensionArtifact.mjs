import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { posix } from 'node:path';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function safeNode(path, directory = false) {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o022
  )
    throw new Error(`Unsafe owned payload: ${path}`);
  if (!directory && stat.size > 2 * 1024 * 1024) throw new Error('Oversized owned payload');
  return stat;
}
export function boundedRead(path) {
  safeNode(path);
  return readFileSync(path);
}
function validEntry(name) {
  if (
    isAbsolute(name) ||
    name.includes('\\') ||
    name.split('/').some((part) => !part || part === '.' || part === '..') ||
    !/^[a-zA-Z0-9_./-]+$/.test(name)
  )
    throw new Error('Unsafe archive entry');
}
export function assertArtifactIdentity(artifact, root) {
  if (
    artifact.root !== root ||
    !/^[a-z0-9-]+\.[a-z0-9-]+$/.test(artifact.id) ||
    !/^\d+\.\d+\.\d+$/.test(artifact.version) ||
    !Array.isArray(artifact.inventory) ||
    artifact.inventory.length < 3 ||
    artifact.inventory.length > 32
  )
    throw new Error('Invalid owned artifact identity');
  const names = new Set();
  let total = 0;
  for (const item of artifact.inventory) {
    validEntry(item.name);
    if (
      names.has(item.name) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 0 ||
      item.bytes > 2 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(item.sha256)
    )
      throw new Error('Invalid owned artifact inventory');
    names.add(item.name);
    total += item.bytes;
  }
  if (
    total > 8 * 1024 * 1024 ||
    !names.has('package.json') ||
    !names.has('LICENSE') ||
    hash(
      JSON.stringify({
        root: artifact.root,
        id: artifact.id,
        version: artifact.version,
        inventory: artifact.inventory,
      }),
    ) !== artifact.digest
  )
    throw new Error('Owned artifact digest mismatch');
}
export function bootstrapPayload(root) {
  root = realpathSync(root);
  const sourceManifest = boundedRead(join(root, 'extensions/devloom-bootstrap/package.json'));
  const manifest = JSON.parse(sourceManifest);
  const lock = JSON.parse(boundedRead(join(root, 'upstream.lock.json')));
  if (
    manifest.publisher !== 'devloom' ||
    manifest.name !== 'devloom-bootstrap' ||
    manifest.version !== '0.0.1' ||
    lock.commit !== '69047191fc427f2f92828279aae1d90d8eeda7ab'
  )
    throw new Error('Unexpected bootstrap identity');
  manifest.devloomLocal = {
    schema: 1,
    sourceRoot: root,
    sourceManifestSha256: hash(sourceManifest),
    upstreamCommit: lock.commit,
    helperRelative: 'crates/devloom-sidecar/target/debug/devloom-sidecar',
  };
  return {
    manifest,
    files: Object.fromEntries(
      ['extension', 'appRoot', 'localGit', 'bridgeClient', 'framing', 'protocol'].map((name) => [
        `dist/${name}.js`,
        join(root, `extensions/devloom-bootstrap/dist/${name}.js`),
      ]),
    ),
  };
}
export function buildLocalArtifact(root, payload = bootstrapPayload(root)) {
  root = realpathSync(root);
  safeNode(root, true);
  const { manifest, files, data = {} } = payload;
  if (
    manifest.publisher !== 'devloom' ||
    !/^[a-z0-9-]+$/.test(manifest.name) ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version)
  )
    throw new Error('Invalid local manifest identity');
  const entries = {
    'package.json': Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    LICENSE: boundedRead(join(root, 'LICENSE')),
  };
  for (const [name, path] of Object.entries(files)) {
    validEntry(name);
    if (
      !name.endsWith('.js') ||
      name.includes('node_modules') ||
      !realpathSync(path).startsWith(`${root}/`)
    )
      throw new Error('Foreign executable payload');
    let parent = root;
    for (const segment of relative(root, path).split('/').slice(0, -1)) {
      parent = join(parent, segment);
      safeNode(parent, true);
    }
    entries[name] = boundedRead(path);
  }
  for (const [name, value] of Object.entries(data)) {
    validEntry(name);
    if (name !== 'fixture.json') throw new Error('Unexpected payload data');
    entries[name] = Buffer.from(`${JSON.stringify(value)}\n`);
  }
  for (const [name, bytes] of Object.entries(entries).filter(([name]) => name.endsWith('.js'))) {
    const source = bytes.toString('utf8');
    for (const match of source.matchAll(/(?:require\(\s*|from\s+|import\s*\()(['"])([^'"]+)\1/g)) {
      const dependency = match[2];
      if (
        dependency === 'vscode' ||
        builtinModules.includes(dependency) ||
        builtinModules.includes(dependency.replace(/^node:/, ''))
      )
        continue;
      if (!dependency.startsWith('.'))
        throw new Error(`Unresolved runtime dependency: ${dependency}`);
      const target = posix.normalize(posix.join(posix.dirname(name), dependency));
      if (!entries[target] && !entries[`${target}.js`])
        throw new Error(`Missing own import closure: ${name} -> ${dependency}`);
    }
  }
  if (
    Object.keys(entries).length > 32 ||
    Object.values(entries).reduce((sum, bytes) => sum + bytes.length, 0) > 8 * 1024 * 1024
  )
    throw new Error('Oversized local artifact');
  if (!entries[manifest.main.replace(/^\.\//, '')]) throw new Error('Missing local entrypoint');
  const inventory = Object.keys(entries)
    .sort()
    .map((name) => ({ name, bytes: entries[name].length, sha256: hash(entries[name]) }));
  const identity = {
    root,
    id: `${manifest.publisher}.${manifest.name}`,
    version: manifest.version,
    inventory,
  };
  const digest = hash(JSON.stringify(identity));
  const tools = join(root, '.tools');
  safeNode(tools, true);
  const directory = join(tools, 'local-vsix');
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  safeNode(directory, true);
  const stage = join(directory, randomUUID());
  mkdirSync(stage, { mode: 0o700 });
  mkdirSync(join(stage, 'extension'), { mode: 0o700 });
  for (const [name, bytes] of Object.entries(entries)) {
    mkdirSync(dirname(join(stage, 'extension', name)), { recursive: true, mode: 0o700 });
    writeFileSync(join(stage, 'extension', name), bytes, { flag: 'wx', mode: 0o600 });
  }
  const archive = join(stage, `${identity.id}.vsix`);
  execFileSync(
    '/usr/bin/zip',
    ['-X', '-q', archive, ...inventory.map(({ name }) => `extension/${name}`)],
    { cwd: stage, timeout: 10000, maxBuffer: 65536 },
  );
  return {
    ...identity,
    digest,
    manifest,
    sourceInventory: inventory.map((item) => ({
      ...item,
      source:
        files[item.name] ??
        (item.name === 'LICENSE'
          ? join(root, 'LICENSE')
          : item.name === 'package.json'
            ? 'generated own manifest'
            : 'generated fixture metadata'),
    })),
    archive,
    archiveSha256: hash(boundedRead(archive)),
    stage,
  };
}
export function verifyInstalled(path, artifact) {
  safeNode(path, true);
  const names = readdirSync(path, { recursive: true })
    .filter((name) => {
      const child = join(path, name);
      const info = lstatSync(child);
      if (info.isSymbolicLink()) throw new Error('Symlink in installed payload');
      safeNode(child, info.isDirectory());
      return info.isFile();
    })
    .sort();
  if (JSON.stringify(names) !== JSON.stringify(artifact.inventory.map(({ name }) => name).sort()))
    throw new Error('Unexpected installed file inventory');
  for (const item of artifact.inventory) {
    let bytes = boundedRead(join(path, item.name));
    if (item.name === 'package.json') {
      const manifest = JSON.parse(bytes);
      delete manifest.__metadata;
      bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    }
    if (hash(bytes) !== item.sha256 || bytes.length !== item.bytes)
      throw new Error(`Installed payload mismatch: ${relative(path, join(path, item.name))}`);
  }
  return true;
}
