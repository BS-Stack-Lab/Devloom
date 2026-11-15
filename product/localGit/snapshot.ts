import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export interface Snapshot {
  root: string;
  common: string;
  worktree: string;
  head: string;
  index: string;
  generation: number;
  destination: boolean;
}
export function digest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function contents(path: string): Buffer {
  try {
    if (statSync(path).size > 16 * 1024 * 1024)
      throw new Error('Git metadata exceeds safe snapshot limit');
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  }
}
export function fileFingerprint(path: string): string {
  if (!existsSync(path)) return 'absent';
  if (statSync(path).size > 256 * 1024 * 1024)
    throw new Error('Git index exceeds safe snapshot limit');
  const descriptor = openSync(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(65536);
  try {
    let size: number;
    let total = 0;
    while ((size = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      total += size;
      if (total > 256 * 1024 * 1024) throw new Error('Git index exceeds safe snapshot limit');
      hash.update(buffer.subarray(0, size));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('hex');
}
export function canonicalDestination(path: string): string {
  const absolute = resolve(path);
  let parent = absolute;
  while (!existsSync(parent)) parent = dirname(parent);
  if (!statSync(parent).isDirectory()) throw new Error('Invalid Git destination');
  const suffix = relative(parent, absolute);
  if (suffix.split(sep).some((part) => part === '..' || /[\0\r\n]/.test(part)))
    throw new Error('Invalid Git destination');
  return resolve(realpathSync(parent), suffix);
}
export function capture(root: string, generation = 0, destination = false): Snapshot {
  const requested = resolve(root);
  root = canonicalDestination(root);
  const dot = join(root, '.git');
  if (destination && (existsSync(dot) || existsSync(join(root, 'HEAD'))))
    return capture(requested, generation);
  if (destination) {
    return {
      root: requested,
      common: root,
      worktree: root,
      head: '',
      index: '',
      generation,
      destination,
    };
  }
  let git = dot;
  if (!existsSync(dot) && existsSync(join(root, 'HEAD'))) git = root;
  else if (statSync(dot).isFile()) {
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(readFileSync(dot, 'utf8'));
    if (!match) throw new Error('Invalid Git directory');
    git = resolve(root, match[1]);
  }
  const worktree = realpathSync(git);
  const commonFile = contents(join(worktree, 'commondir'))
    .toString()
    .replace(/\r?\n$/, '');
  const common = realpathSync(commonFile ? resolve(worktree, commonFile) : worktree);
  if (existsSync(join(common, 'reftable')))
    throw new Error(
      'UnsupportedRefStorage: reftable repositories require a supported snapshot reader before Git writes.',
    );
  const headText = contents(join(worktree, 'HEAD'))
    .toString()
    .replace(/\r?\n$/, '');
  let head = headText;
  if (!headText.startsWith('ref: ') && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(headText))
    throw new Error('Unsupported Git HEAD format. Review the repository before Git writes.');
  if (headText.startsWith('ref: ')) {
    const ref = headText.slice(5);
    const refPath = resolve(common, ref);
    if (
      !ref.startsWith('refs/') ||
      relative(common, refPath).split(sep).includes('..') ||
      /[\0\r\n]/.test(ref)
    )
      throw new Error('Invalid HEAD reference');
    const resolvedRef = existsSync(refPath)
      ? realpathSync(refPath)
      : canonicalDestination(dirname(refPath));
    if (relative(common, resolvedRef).split(sep).includes('..'))
      throw new Error('Unsafe HEAD reference');
    const loose = contents(join(common, ref))
      .toString()
      .replace(/\r?\n$/, '');
    if (loose.startsWith('ref: '))
      throw new Error(
        'Unsupported symbolic branch reference. Review the repository ref storage before Git writes.',
      );
    const packed = contents(join(common, 'packed-refs'))
      .toString()
      .split('\n')
      .find((line) => line.endsWith(` ${ref}`));
    const oid = loose || packed?.split(' ')[0];
    if (oid && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid))
      throw new Error('Invalid Git reference object ID');
    head += `:${oid || 'unborn'}`;
  }
  return {
    root: requested,
    common,
    worktree,
    head,
    index: fileFingerprint(join(worktree, 'index')),
    generation,
    destination,
  };
}
export function validate(expected: Snapshot): void {
  const current = capture(expected.root, expected.generation, expected.destination);
  if (JSON.stringify(current) !== JSON.stringify(expected))
    throw new Error(
      'Git state changed. Refresh Source Control and review the changes before retrying.',
    );
}
