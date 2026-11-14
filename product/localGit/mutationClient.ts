import { isReadOnly, validateEnvironment } from './commandPolicy';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createConnection, Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { FrameDecoder, encode } from '../../extensions/devloom-bootstrap/src/framing';
import { validateEndpoint } from './mutationJournal';
import { directory, recovery } from './mutationBroker';
import { canonicalDestination, capture, Snapshot, validate } from './snapshot';
export { capture, fileFingerprint } from './snapshot';
interface Lease {
  snapshot: Snapshot;
  kind: 'repository' | 'init' | 'clone';
  children: Set<Promise<void>>;
  ambiguous: boolean;
  active: boolean;
  socket: Socket;
}
interface Trace {
  event: string;
  at: number;
  pid?: number;
  command?: string;
}
const events: Trace[] = [];
function trace(event: string, pid?: number, command?: string): void {
  events.push({
    event,
    at: Date.now(),
    pid,
    command: command && /^[a-z-]{1,32}$/.test(command) ? command : undefined,
  });
  if (events.length > 128) events.shift();
}
interface Reply {
  version: number;
  id: string;
  capability?: string;
  error?: string;
  state?: string;
  clientPid?: number;
  events?: Trace[];
}
const context = new AsyncLocalStorage<Lease>();
export class MutationClient {
  constructor(private location = directory) {}
  private async connection(): Promise<Socket> {
    validateEndpoint(this.location);
    return await new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(join(this.location, 'broker.sock'));
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.removeListener('error', reject);
        resolve(socket);
      });
    });
  }
  private request(socket: Socket, request: object): Promise<Reply> {
    if (socket.destroyed) return Promise.reject(new Error(recovery));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const decoder = new FrameDecoder();
      const timer = setTimeout(() => done(new Error(recovery)), 35000);
      const close = () => done(new Error(recovery));
      const data = (chunk: Buffer) => {
        try {
          for (const value of decoder.push(chunk)) {
            const reply = value as Reply;
            if (reply.version !== 1 || reply.id !== id) throw new Error('Invalid broker response');
            done(reply.error ? new Error(reply.error) : undefined, reply);
          }
        } catch {
          done(new Error('Invalid broker response'));
        }
      };
      const done = (error?: Error, value?: Reply) => {
        clearTimeout(timer);
        socket.removeListener('data', data);
        socket.removeListener('close', close);
        socket.removeListener('error', close);
        if (error) reject(error);
        else resolve(value!);
      };
      socket.on('data', data);
      socket.once('close', close);
      socket.once('error', close);
      socket.write(encode({ version: 1, id, ...request }));
    });
  }
  async diagnose(): Promise<Reply> {
    const socket = await this.connection();
    try {
      return {
        ...(await this.request(socket, { method: 'diagnose' })),
        clientPid: process.pid,
        events: [...events],
      };
    } finally {
      socket.destroy();
    }
  }
  async run<T>(
    snapshot: Snapshot,
    kind: 'repository' | 'init' | 'clone',
    action: () => Promise<T>,
  ): Promise<T> {
    const nested = context.getStore();
    if (nested) {
      if (!nested.active || nested.socket.destroyed) throw new Error(recovery);
      if (nested.snapshot.common !== snapshot.common)
        throw new Error('Nested mutation across repositories requires separate review.');
      return await action();
    }
    const socket = await this.connection();
    socket.on('error', () => {});
    let lease: Lease | undefined;
    try {
      const grant = await this.request(socket, {
        method: 'acquire',
        snapshot,
        kind,
        pid: process.pid,
      });
      if (typeof grant.capability !== 'string') throw new Error('Invalid Git lease');
      trace('grant');
      lease = { snapshot, kind, children: new Set(), ambiguous: false, active: true, socket };
      let result: T | undefined;
      let failure: unknown;
      let failed = false;
      try {
        validate(snapshot);
        result = await context.run(lease, action);
      } catch (error) {
        failed = true;
        trace('operation-failed');
        failure = error;
        if (error instanceof Error && /cancel/i.test(error.name)) lease.ambiguous = true;
      }
      lease.active = false;
      await Promise.all([...lease.children]);
      trace('release-request');
      await this.request(socket, {
        method: 'release',
        capability: grant.capability,
        clean: !lease.ambiguous,
      });
      trace('released');
      if (failed) throw failure;
      return result as T;
    } finally {
      if (lease) lease.active = false;
      socket.destroy();
    }
  }
}
export const client = new MutationClient();
export function inLease(): boolean {
  const lease = context.getStore();
  return !!lease?.active && !lease.socket.destroyed;
}
export function assertFresh(): void {
  const lease = context.getStore();
  if (!lease || !inLease()) throw new Error(recovery);
  validate(lease.snapshot);
}
export function track(child: ChildProcess, command?: string): void {
  const lease = context.getStore();
  if (!lease) return;
  if (!lease.active || lease.socket.destroyed) throw new Error(recovery);
  trace('child-start', child.pid, command);
  const closed = new Promise<void>((resolve) => {
    child.once('error', () => {
      lease.ambiguous = true;
    });
    child.once('close', (_code, signal) => {
      trace('child-close', child.pid, command);
      if (signal || child.killed) lease.ambiguous = true;
      resolve();
    });
  });
  lease.children.add(closed);
}
export function assertSpawn(
  args: string[],
  trusted: boolean,
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  validateEnvironment(environment);
  if (!trusted) throw new Error('Trust this workspace before using repository Git.');
  const lease = context.getStore();
  if (lease && (!lease.active || lease.socket.destroyed)) throw new Error(recovery);
  const readonly = isReadOnly(args);
  if (!readonly && !inLease())
    throw new Error(
      'Git mutation requires the shared coordinator. Refresh Source Control and retry.',
    );
  if (!readonly) {
    const active = context.getStore()!;
    if (!cwd) throw new Error('Git mutation has no repository identity.');
    const matches =
      active.kind === 'repository'
        ? capture(cwd).common === active.snapshot.common
        : canonicalDestination(cwd) ===
          (active.kind === 'clone'
            ? dirname(active.snapshot.common)
            : canonicalDestination(active.snapshot.root));
    if (!matches) throw new Error('Git mutation does not match its coordinated repository.');
  }
  return readonly;
}
