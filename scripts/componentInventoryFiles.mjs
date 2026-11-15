import * as fs from 'node:fs';
import { resolve, relative, isAbsolute, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
export const limits = Object.freeze({
  entries: 500000,
  depth: 32,
  json: 8388608,
  license: 67108864,
  binary: 1073741824,
  total: 8589934592,
  stdout: 33554432,
  timeout: 30000,
});
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const within = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
};
export const safeText = (value, max = 256) =>
  typeof value === 'string' &&
  value.length <= max &&
  /^[\w@./ +()\-*:<>|=]+$/u.test(value) &&
  !value.includes('://') &&
  !value.includes('..')
    ? value
    : 'unknown';
export function safeUrl(value) {
  try {
    const url = new URL(typeof value === 'object' ? value?.url : value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      ? url.href
      : 'unknown';
  } catch {
    return 'unknown';
  }
}
export function createFiles(root, overrides = {}) {
  root = fs.realpathSync(root);
  const bound = { ...limits, ...overrides };
  const diagnostics = [];
  let entries = 0,
    total = 0;
  const pathOf = (path) => relative(root, path).split('\\').join('/');
  const issue = (code, path) => {
    diagnostics.push({
      code,
      path: within(root, resolve(path)) ? pathOf(resolve(path)) : 'unsupported-external-source',
    });
    return null;
  };
  function checked(path, scopes = [root], follow = false) {
    path = resolve(path);
    if (!scopes.some((scope) => within(scope, path))) throw new Error('scope-escape');
    let cursor = path;
    while (cursor !== dirname(cursor)) {
      if (fs.lstatSync(cursor).isSymbolicLink() && !follow) throw new Error('symlink-refused');
      if (scopes.includes(cursor)) break;
      cursor = dirname(cursor);
    }
    const real = fs.realpathSync(path);
    if (!scopes.some((scope) => within(scope, real))) throw new Error('symlink-escape');
    return real;
  }
  function read(path, kind = 'json', scopes = [root]) {
    let fd;
    try {
      const real = checked(path, scopes);
      fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const before = fs.fstatSync(fd);
      if (!before.isFile()) return issue('not-regular-file', path);
      if (before.size > bound[kind] || total + before.size > bound.total)
        return issue('byte-limit', path);
      const hash = createHash('sha256'),
        chunks = [],
        chunk = Buffer.alloc(262144);
      let count = 0,
        size;
      while ((size = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
        count += size;
        total += size;
        if (count > bound[kind] || total > bound.total) return issue('byte-limit', path);
        hash.update(chunk.subarray(0, size));
        if (kind === 'json') chunks.push(Buffer.from(chunk.subarray(0, size)));
      }
      const after = fs.fstatSync(fd);
      if (
        count !== before.size ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        return issue('unknown-changed', path);
      return {
        path: pathOf(real),
        sha256: hash.digest('hex'),
        bytes: kind === 'json' ? Buffer.concat(chunks) : undefined,
      };
    } catch (error) {
      return issue(
        ['scope-escape', 'symlink-escape', 'symlink-refused'].includes(error.message)
          ? error.message
          : 'read-unavailable',
        path,
      );
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  function json(path) {
    const file = read(path);
    if (!file) return null;
    try {
      return { ...file, value: JSON.parse(file.bytes.toString('utf8')) };
    } catch {
      return issue('invalid-json', path);
    }
  }
  function directory(path, optional = false) {
    try {
      checked(path);
      const names = fs.readdirSync(path).sort();
      entries += names.length;
      if (entries > bound.entries) return issue('entry-limit', path) ?? [];
      return names;
    } catch (error) {
      if (!optional || error.code !== 'ENOENT') issue('directory-unavailable', path);
      return [];
    }
  }
  function walk(start, visit, options = {}) {
    const scope = resolve(start),
      seen = new Set();
    function descend(path, depth) {
      if (depth > bound.depth) {
        issue('depth-limit', path);
        return;
      }
      let stat, real;
      try {
        stat = fs.lstatSync(path);
        if (stat.isSymbolicLink()) {
          real = checked(path, [scope], true);
          if (!options.followLinks) {
            issue('symlink-skipped', path);
            return;
          }
          stat = fs.statSync(real);
        } else real = checked(path, [scope]);
      } catch (error) {
        issue(
          ['scope-escape', 'symlink-escape'].includes(error.message)
            ? error.message
            : 'symlink-or-read-unavailable',
          path,
        );
        return;
      }
      if (seen.has(real)) return;
      seen.add(real);
      if (stat.isDirectory()) {
        let names;
        try {
          names = fs.readdirSync(real).sort();
        } catch {
          issue('directory-unavailable', path);
          return;
        }
        entries += names.length;
        if (entries > bound.entries) {
          issue('entry-limit', path);
          return;
        }
        for (const name of names)
          if (!options.skip?.(name, real)) descend(resolve(real, name), depth + 1);
      } else if (stat.isFile()) visit(real, stat);
    }
    descend(scope, 0);
  }
  function licenses(path, manifest = {}) {
    const names = directory(path);
    const requested =
      typeof manifest.license === 'string'
        ? /^SEE LICENSE IN (.+)$/i.exec(manifest.license)?.[1]
        : undefined;
    const selected = names.filter((name) =>
      /^(licen[cs]e|copying|notice|thirdpartynotices)([._-].*)?$/i.test(name),
    );
    if (requested && !selected.includes(requested)) {
      if (!isAbsolute(requested) && within(path, resolve(path, requested)))
        selected.push(requested);
      else issue('license-path-refused', path);
    }
    return selected.sort().flatMap((name) => {
      const file = read(resolve(path, name), 'license', [path]);
      return file ? [{ path: file.path, sha256: file.sha256 }] : [];
    });
  }
  function component(path, kind) {
    const file = json(resolve(path, 'package.json'));
    if (!file) return null;
    const value = file.value;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return issue('invalid-manifest', path);
    const license = safeText(
      typeof value.license === 'object' ? value.license?.type : value.license,
      1024,
    );
    return {
      kind,
      path: pathOf(path),
      name: safeText(value.name),
      version: safeText(value.version),
      license,
      repository: safeUrl(value.repository),
      manifestSha256: file.sha256,
      licenses: licenses(path, value),
      runtimeLoaded: 'unknown',
      distributed: 'unknown',
    };
  }
  return {
    root,
    limits: bound,
    diagnostics,
    pathOf,
    issue,
    checked,
    read,
    json,
    directory,
    walk,
    licenses,
    component,
  };
}
export const licenseComplete = (component) =>
  component.license !== 'unknown' && component.licenses?.length > 0;
export const nativeName = (path) => /\.(node|dylib|so)(\.\d+)*$/i.test(basename(path));
