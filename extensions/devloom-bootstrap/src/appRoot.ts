import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const upstreamCommit = '69047191fc427f2f92828279aae1d90d8eeda7ab';
const helperRelative = 'crates/devloom-sidecar/target/debug/devloom-sidecar';
type ObjectValue = Record<string, unknown>;
function safe(path: string, directory = false): void {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o022 ||
    (!directory && stat.size > 1024 * 1024)
  )
    throw new Error(`Unsafe application root member: ${path}`);
}
function json(path: string): ObjectValue {
  safe(path);
  return JSON.parse(readFileSync(path, 'utf8')) as ObjectValue;
}
export function resolveApplicationHelper(
  extensionPath: string,
  mode: 'production' | 'development' | 'test',
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = environment.DEVLOOM_APP_ROOT;
  if (explicit === undefined && mode === 'production')
    throw new Error(
      'DEVLOOM_APP_ROOT is required for the installed extension; start Devloom through its launcher',
    );
  if (explicit !== undefined && (!explicit || !isAbsolute(explicit)))
    throw new Error('Invalid explicit DEVLOOM_APP_ROOT');
  const candidate = explicit ?? resolve(extensionPath, '../..');
  safe(candidate, true);
  const root = realpathSync(candidate);
  const source = json(join(root, 'package.json'));
  const lock = json(join(root, 'upstream.lock.json'));
  const manifestPath = join(root, 'extensions/devloom-bootstrap/package.json');
  const bootstrap = json(manifestPath);
  const engines = bootstrap.engines as ObjectValue | undefined;
  if (
    source.name !== 'devloom' ||
    source.private !== true ||
    lock.commit !== upstreamCommit ||
    lock.version !== '1.146.0' ||
    bootstrap.publisher !== 'devloom' ||
    bootstrap.name !== 'devloom-bootstrap' ||
    bootstrap.private !== true ||
    bootstrap.version !== '0.0.1' ||
    engines?.vscode !== '^1.146.0'
  )
    throw new Error('Application root identity does not match the pinned Devloom source');
  safe(extensionPath, true);
  const installed = json(join(extensionPath, 'package.json'));
  if (mode === 'production') {
    const provenance = installed.devloomLocal as ObjectValue | undefined;
    if (
      installed.publisher !== bootstrap.publisher ||
      installed.name !== bootstrap.name ||
      installed.version !== bootstrap.version ||
      provenance?.schema !== 1 ||
      provenance.sourceRoot !== root ||
      provenance.upstreamCommit !== upstreamCommit ||
      provenance.helperRelative !== helperRelative ||
      provenance.sourceManifestSha256 !==
        createHash('sha256').update(readFileSync(manifestPath)).digest('hex')
    )
      throw new Error('Installed extension provenance does not match DEVLOOM_APP_ROOT');
  } else if (realpathSync(extensionPath) !== join(root, 'extensions/devloom-bootstrap'))
    throw new Error('Development extension path does not match application root');
  const segments = (process.platform === 'win32' ? `${helperRelative}.exe` : helperRelative).split(
    '/',
  );
  let path = root;
  for (const segment of segments.slice(0, -1)) {
    path = join(path, segment);
    safe(path, true);
  }
  const helper = join(path, segments[segments.length - 1]);
  const info = lstatSync(helper);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o022 ||
    !(info.mode & 0o111) ||
    realpathSync(helper) !== helper ||
    !helper.startsWith(`${root}/`)
  )
    throw new Error('Missing or unsafe fixed Devloom Rust helper');
  return helper;
}
