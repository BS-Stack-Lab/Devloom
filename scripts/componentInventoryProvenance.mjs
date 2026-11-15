import * as fs from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { within, safeText, safeUrl, nativeName } from './componentInventoryFiles.mjs';
export function nativeArtifact(files, path, stat, owner = 'unknown') {
  let type = 'unknown';
  const explicit = nativeName(path);
  if (!explicit && !(stat.mode & 0o111)) return null;
  let fd;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const header = Buffer.alloc(4);
    fs.readSync(fd, header, 0, 4, 0);
    const magic = header.toString('hex');
    if (['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca'].includes(magic))
      type = 'Mach-O';
    else if (magic === '7f454c46') type = 'ELF';
    else if (magic.startsWith('4d5a')) type = 'PE';
    else if (!explicit) return null;
  } catch {
    files.issue('native-read-unavailable', path);
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const file = files.read(path, 'binary');
  return file
    ? {
        path: file.path,
        sha256: file.sha256,
        type,
        owner,
        runtimeLoaded: 'unknown',
        distributed: 'unknown',
      }
    : null;
}
export function electronProvenance(files, upstream, declaredVersion) {
  const base = resolve(upstream, '.build/electron');
  const artifacts = [],
    licenses = [],
    versions = [];
  files.walk(
    base,
    (path, stat) => {
      if (/^(version|version\.txt)$/i.test(path.split('/').at(-1))) {
        const file = files.read(path);
        if (file)
          versions.push({
            path: file.path,
            version: safeText(file.bytes.toString().trim()),
            sha256: file.sha256,
          });
      }
      if (/^(license|thirdpartynotices|notice)([._-].*)?$/i.test(path.split('/').at(-1))) {
        const file = files.read(path, 'license');
        if (file) licenses.push({ path: file.path, sha256: file.sha256 });
      }
      const artifact = nativeArtifact(files, path, stat, 'electron');
      if (artifact) artifacts.push(artifact);
    },
    { followLinks: true },
  );
  if (!artifacts.length || !versions.length) files.issue('electron-provenance-unavailable', base);
  return {
    declaredVersion: safeText(declaredVersion),
    versions,
    licenses,
    artifacts,
    installProvenance: 'observed-local-bytes',
    buildProvenance: 'unknown',
    runtimeLoaded: 'unknown',
    distributed: 'unknown',
  };
}
export function rustProvenance(files, { spawn = execFileSync } = {}) {
  const manifest = resolve(files.root, 'crates/devloom-sidecar/Cargo.toml');
  const lock = files.read(resolve(dirname(manifest), 'Cargo.lock'));
  const source = files.read(manifest);
  const packages = [];
  try {
    const output = spawn(
      resolve(files.root, '.tools/cargo/bin/cargo'),
      ['metadata', '--format-version', '1', '--locked', '--offline', '--manifest-path', manifest],
      {
        cwd: files.root,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: files.limits.timeout,
        maxBuffer: files.limits.stdout,
        env: {
          PATH: `${resolve(files.root, '.tools/cargo/bin')}:/usr/bin:/bin`,
          CARGO_HOME: resolve(files.root, '.tools/cargo'),
          RUSTUP_HOME: resolve(files.root, '.tools/rustup'),
          CARGO_NET_OFFLINE: 'true',
          LANG: 'C',
          LC_ALL: 'C',
          HOME: '/dev/null',
        },
      },
    );
    const metadata = JSON.parse(output.toString());
    if (!Array.isArray(metadata.packages)) throw new Error('invalid-metadata');
    for (const item of metadata.packages) {
      const path = item.manifest_path;
      const scopes = [
        resolve(files.root, 'crates/devloom-sidecar'),
        resolve(files.root, '.tools/cargo/registry/src'),
      ];
      if (typeof path !== 'string' || !scopes.some((scope) => within(scope, path))) {
        files.issue('unsupported-external-source', files.root);
        continue;
      }
      const file = files.read(path, 'json', scopes);
      const licenseFiles = files.licenses(dirname(path), {
        license: item.license_file ? `SEE LICENSE IN ${item.license_file}` : item.license,
      });
      packages.push({
        kind: 'rust',
        path: file?.path ?? 'unknown',
        name: safeText(item.name),
        version: safeText(item.version),
        license: safeText(item.license, 1024),
        repository: safeUrl(item.repository),
        manifestSha256: file?.sha256 ?? 'unknown',
        licenses: licenseFiles,
        source:
          typeof item.source === 'string' && item.source.startsWith('registry+')
            ? 'registry'
            : 'local',
        runtimeLoaded: 'unknown',
        distributed: 'unknown',
      });
    }
  } catch {
    files.issue('cargo-offline-metadata-unavailable', manifest);
  }
  return {
    manifestSha256: source?.sha256 ?? 'unknown',
    lockSha256: lock?.sha256 ?? 'unknown',
    packages,
    buildProvenance: 'unknown',
    runtimeLoaded: 'unknown',
    distributed: 'unknown',
  };
}
