import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
export interface Ownership {
  id: string;
  common: string;
  worktree: string;
  kind: string;
  mainPid: number;
  clientPid: number;
  generation: string;
  state: 'active' | 'quarantined';
}
export function secureDirectory(directory: string): void {
  if (!directory.startsWith('/') || Buffer.byteLength(join(directory, 'broker.sock')) > 100)
    throw new Error('Git coordinator socket path is too long or not absolute');
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  validateDirectory(directory);
}
export function validateDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('Unsafe Git coordinator directory');
}
export function validateEndpoint(directory: string): void {
  validateDirectory(directory);
  const stat = lstatSync(join(directory, 'broker.sock'));
  if (
    !stat.isSocket() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o600
  )
    throw new Error('Unsafe Git coordinator socket');
}
export class MutationJournal {
  private path: string;
  record: Ownership | undefined;
  constructor(private directory: string) {
    secureDirectory(directory);
    this.path = join(directory, 'ownership.json');
    try {
      const stat = lstatSync(this.path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o777) !== 0o600
      )
        throw new Error('Unsafe Git ownership journal');
      if (stat.size > 16384) throw new Error('Invalid Git ownership journal');
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as {
        version: number;
        record: Ownership | null;
      };
      if (!value || Object.keys(value).sort().join(',') !== 'record,version' || value.version !== 1)
        throw new Error('Invalid Git ownership journal');
      if (value.record !== null) {
        const record = value.record;
        if (
          !record ||
          Object.keys(record).sort().join(',') !==
            'clientPid,common,generation,id,kind,mainPid,state,worktree' ||
          !['active', 'quarantined'].includes(record.state) ||
          !['repository', 'init', 'clone'].includes(record.kind) ||
          !Number.isSafeInteger(record.mainPid) ||
          record.mainPid <= 0 ||
          !Number.isSafeInteger(record.clientPid) ||
          record.clientPid <= 0 ||
          ![record.id, record.generation, record.common, record.worktree].every(
            (field) => typeof field === 'string' && field.length > 0 && field.length <= 4096,
          )
        )
          throw new Error('Invalid Git ownership journal');
      }
      this.record = value.record ?? undefined;
      if (this.record) this.write({ ...this.record, state: 'quarantined' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  write(record?: Ownership): void {
    this.record = record ?? this.record;
    const temporary = `${this.path}.next`;
    const descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, JSON.stringify({ version: 1, record: record ?? null }));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, this.path);
    const directory = openSync(this.directory, constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    this.record = record;
  }
}
