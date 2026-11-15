import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { safeText, safeUrl, within, licenseComplete } from './componentInventoryFiles.mjs';
import {
  nativeArtifact,
  electronProvenance,
  rustProvenance,
} from './componentInventoryProvenance.mjs';
export function collectExtensions(files, upstream, product) {
  const extensions = [],
    installRoots = [];
  for (const [kind, base] of [
    ['source', 'extensions'],
    ['downloaded', '.build/builtInExtensions'],
  ]) {
    const directory = resolve(upstream, base);
    for (const name of files.directory(directory)) {
      const path = resolve(directory, name);
      let stat;
      try {
        stat = fs.lstatSync(path);
      } catch {
        files.issue('extension-unavailable', path);
        continue;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        if (stat.isSymbolicLink()) files.issue('extension-symlink-refused', path);
        continue;
      }
      if (kind === 'source' && ['types', 'out', 'node_modules'].includes(name)) continue;
      const component = files.component(path, kind);
      if (!component) continue;
      const manifest = files.json(resolve(path, 'package.json'))?.value;
      component.id = safeText(`${manifest?.publisher ?? 'unknown'}.${manifest?.name ?? 'unknown'}`);
      const declaration = (
        Array.isArray(product?.builtInExtensions) ? product.builtInExtensions : []
      ).find((item) => item.name === manifest?.name || item.name === component.id);
      component.declaredArchiveSha256 =
        typeof declaration?.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(declaration.sha256)
          ? declaration.sha256
          : 'unknown';
      component.declaredSource = safeUrl(declaration?.repo);
      extensions.push(component);
      if (fs.existsSync(resolve(path, 'node_modules')))
        installRoots.push(resolve(path, 'node_modules'));
    }
  }
  return { extensions, installRoots };
}
export function collectPackages(files, roots, workspacePaths = []) {
  const scopes = [...roots, ...workspacePaths];
  const packages = [],
    nativeArtifacts = [],
    seen = new Set(),
    visitedModules = new Set();
  function packageAt(path, scope, depth) {
    let real;
    try {
      real = files.checked(path, scopes, true);
    } catch (error) {
      files.issue(
        ['scope-escape', 'symlink-escape'].includes(error.message)
          ? error.message
          : 'package-link-refused',
        path,
      );
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    const component = files.component(real, 'installed');
    if (!component) return;
    component.key = `${files.pathOf(scope)}:${component.path}:${component.name}:${component.version}`;
    packages.push(component);
    files.walk(
      real,
      (file, stat) => {
        const artifact = nativeArtifact(files, file, stat, component.key);
        if (artifact) nativeArtifacts.push(artifact);
      },
      { skip: (name) => name === 'node_modules', followLinks: true },
    );
    modules(resolve(real, 'node_modules'), scope, true, depth + 1);
  }
  function modules(path, scope, optional = false, depth = 0) {
    if (depth > files.limits.depth) {
      files.issue('depth-limit', path);
      return;
    }
    if (visitedModules.has(path)) return;
    visitedModules.add(path);
    for (const name of files.directory(path, optional)) {
      if (name === '.pnpm') {
        for (const entry of files.directory(resolve(path, name))) {
          const candidate = resolve(path, name, entry, 'node_modules');
          if (fs.existsSync(candidate)) modules(candidate, scope, false, depth + 1);
        }
      } else if (name.startsWith('@')) {
        for (const child of files.directory(resolve(path, name)))
          packageAt(resolve(path, name, child), scope, depth);
      } else if (!name.startsWith('.')) {
        const candidate = resolve(path, name);
        try {
          if (fs.lstatSync(candidate).isDirectory() || fs.lstatSync(candidate).isSymbolicLink())
            packageAt(candidate, scope, depth);
          else {
            const artifact = nativeArtifact(files, candidate, fs.lstatSync(candidate));
            if (artifact) nativeArtifacts.push(artifact);
          }
        } catch {
          files.issue('package-unavailable', candidate);
        }
      }
    }
  }
  for (const path of roots) modules(path, path);
  return { packages, nativeArtifacts };
}
export function workspaceRoots(files, upstream) {
  const config = files.read(resolve(upstream, 'pnpm-workspace.yaml'));
  if (!config) return [];
  const roots = [];
  let inPackages = false;
  for (const line of config.bytes.toString('utf8').split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) break;
    if (!inPackages) continue;
    const match = /^\s+-\s+['"]?([a-zA-Z0-9_./*-]+)['"]?\s*$/.exec(line);
    if (!match || match[1].includes('..')) {
      if (line.trim() && !line.trim().startsWith('#'))
        files.issue('workspace-pattern-unsupported', resolve(upstream, 'pnpm-workspace.yaml'));
      continue;
    }
    const parts = match[1].split('/');
    let paths = [upstream];
    for (const part of parts) {
      if (part === '*')
        paths = paths.flatMap((base) => files.directory(base).map((name) => resolve(base, name)));
      else if (part.includes('*')) {
        files.issue('workspace-pattern-unsupported', resolve(upstream, 'pnpm-workspace.yaml'));
        paths = [];
        break;
      } else paths = paths.map((base) => resolve(base, part));
    }
    for (const path of paths) if (within(upstream, path)) roots.push(path);
  }
  return roots;
}
export function collectInventory(files, provenance, options = {}) {
  const upstream = resolve(files.root, 'vendor/code-oss');
  const evidence = [];
  for (const path of [
    'package.json',
    'pnpm-lock.yaml',
    'LICENSE',
    'rust-toolchain.toml',
    'upstream.lock.json',
    'product/devloom.json',
    'vendor/code-oss/package.json',
    'vendor/code-oss/product.json',
    'vendor/code-oss/pnpm-lock.yaml',
    'vendor/code-oss/pnpm-workspace.yaml',
    'vendor/code-oss/.nvmrc',
    'vendor/code-oss/LICENSE.txt',
    'vendor/code-oss/ThirdPartyNotices.txt',
  ]) {
    const file = files.read(
      resolve(files.root, path),
      /LICENSE|Notices/.test(path) ? 'license' : 'json',
    );
    if (file) evidence.push({ path: file.path, sha256: file.sha256 });
  }
  const product = files.json(resolve(upstream, 'product.json'))?.value;
  const manifest = files.json(resolve(upstream, 'package.json'))?.value;
  const { extensions, installRoots } = collectExtensions(files, upstream, product);
  const workspacePaths = workspaceRoots(files, upstream);
  const roots = [
    ...new Set([
      resolve(files.root, 'node_modules'),
      resolve(upstream, 'node_modules'),
      ...installRoots,
      ...workspacePaths
        .filter((path) => fs.existsSync(resolve(path, 'node_modules')))
        .map((path) => resolve(path, 'node_modules')),
    ]),
  ].sort();
  const installed = collectPackages(files, roots, workspacePaths);
  const electron = electronProvenance(
    files,
    upstream,
    manifest?.electronVersion ??
      manifest?.devDependencies?.electron ??
      manifest?.nativeBuild?.target,
  );
  const rust = rustProvenance(files, options);
  const own = files.component(files.root, 'source');
  const components = [
    ...extensions,
    ...installed.packages,
    ...rust.packages,
    ...(own ? [own] : []),
  ];
  const complete = files.diagnostics.length === 0;
  return {
    scope: {
      description:
        'Component metadata, license evidence and specified native artifacts; source contents are not fully attested',
      installRoots: roots.map(files.pathOf),
      workspacePackages: workspacePaths.map(files.pathOf),
      runtimeLoaded: 'unknown',
      distributed: 'unknown',
    },
    limits: files.limits,
    provenance: { ...provenance, files: evidence, ownComponent: own },
    extensions,
    ...installed,
    electron,
    rust,
    diagnostics: files.diagnostics,
    scanCompleteness: complete ? 'complete' : 'incomplete',
    licenseCoverage: complete
      ? components.every(licenseComplete) && electron.licenses.length > 0
        ? 'complete'
        : 'partial'
      : 'unknown',
    legalApproval: 'not-assessed',
  };
}
