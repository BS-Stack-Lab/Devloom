import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { createConnection, createServer, Server, Socket } from 'node:net';
import { join } from 'node:path';
import { FrameDecoder, encode } from '../../extensions/devloom-bootstrap/src/framing';
import { MutationJournal, secureDirectory, validateEndpoint } from './mutationJournal';
import { capture, Snapshot, validate } from './snapshot';
export const directory =
  process.env.VSCODE_DEV === '1' && process.env.DEVLOOM_GIT_TEST_DIRECTORY
    ? process.env.DEVLOOM_GIT_TEST_DIRECTORY
    : `/tmp/devloom-git-${process.getuid?.()}`;
export const recovery =
  'Git ownership is quarantined. Inspect OS processes and repository state before manual recovery. Restart does not establish safety; do not remove Git lockfiles.';
const kinds = new Set(['repository', 'init', 'clone']);
interface Request {
  version: 1;
  id: string;
  method: 'acquire' | 'release' | 'diagnose';
  snapshot?: Snapshot;
  kind?: string;
  capability?: string;
  clean?: boolean;
  pid?: number;
}
interface Waiting {
  socket: Socket;
  request: Request;
  timer: NodeJS.Timeout;
}
export class MutationBroker {
  private journal!: MutationJournal;
  private server: Server;
  private queue: Waiting[] = [];
  private active?: { socket: Socket; id: string; capability: string };
  private sockets = new Set<Socket>();
  constructor(readonly location = directory) {
    secureDirectory(location);
    this.server = createServer((socket) => this.connect(socket));
  }
  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(join(this.location, 'broker.sock'), () => {
        this.server.removeListener('error', reject);
        try {
          chmodSync(join(this.location, 'broker.sock'), 0o600);
          this.journal = new MutationJournal(this.location);
          resolve();
        } catch (error) {
          this.server.close();
          reject(error);
        }
      });
    });
  }
  private reply(socket: Socket, id: string, result: object): void {
    if (!socket.destroyed) socket.write(encode({ version: 1, id, ...result }));
  }
  private connect(socket: Socket): void {
    this.sockets.add(socket);
    const decoder = new FrameDecoder();
    const ids = new Set<string>();
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const value of decoder.push(chunk)) {
          if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('Invalid request');
          const request = value as Request;
          if (
            request.version !== 1 ||
            typeof request.id !== 'string' ||
            !/^[a-zA-Z0-9-]{1,64}$/.test(request.id) ||
            ids.has(request.id) ||
            ids.size >= 4096
          )
            throw new Error('Invalid request');
          ids.add(request.id);
          this.handle(socket, request);
        }
      } catch {
        socket.destroy();
      }
    });
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.queue = this.queue.filter((entry) => {
        if (entry.socket !== socket) return true;
        clearTimeout(entry.timer);
        return false;
      });
      if (this.active?.socket === socket) this.quarantine();
    });
  }
  private handle(socket: Socket, request: Request): void {
    try {
      if (request.method === 'diagnose') {
        this.reply(socket, request.id, {
          state: this.journal.record?.state ?? (this.active ? 'active' : 'ready'),
          queued: this.queue.length,
          mainPid: process.pid,
        });
      } else if (request.method === 'release') {
        if (
          !this.active ||
          this.active.socket !== socket ||
          request.capability !== this.active.capability
        )
          throw new Error('Invalid lease capability');
        if (request.clean !== true) {
          this.quarantine();
          throw new Error(recovery);
        }
        this.journal.write();
        this.active = undefined;
        this.reply(socket, request.id, { released: true });
        this.pump();
      } else if (request.method === 'acquire') {
        if (
          !request.snapshot ||
          !kinds.has(request.kind ?? '') ||
          !Number.isSafeInteger(request.pid) ||
          request.pid! <= 0
        )
          throw new Error('Invalid acquisition');
        const snapshot = request.snapshot;
        if (
          typeof snapshot.root !== 'string' ||
          snapshot.root.length > 4096 ||
          !Number.isSafeInteger(snapshot.generation) ||
          snapshot.generation < 0 ||
          typeof snapshot.destination !== 'boolean'
        )
          throw new Error('Invalid identity');
        if (this.journal.record?.state === 'quarantined') throw new Error(recovery);
        const actual = capture(snapshot.root, snapshot.generation, snapshot.destination);
        if (JSON.stringify(snapshot) !== JSON.stringify(actual))
          throw new Error('Git state changed. Refresh Source Control and review before retrying.');
        if (
          this.queue.length >= 256 ||
          this.queue.filter((entry) => entry.socket === socket).length >= 64
        )
          throw new Error('Git coordinator queue full');
        const entry: Waiting = {
          socket,
          request,
          timer: setTimeout(() => {
            this.queue = this.queue.filter((item) => item !== entry);
            this.reply(socket, request.id, { error: 'Git acquisition deadline exceeded' });
          }, 30000),
        };
        this.queue.push(entry);
        this.pump();
      } else throw new Error('Unsupported Git coordinator request');
    } catch (error) {
      this.reply(socket, request.id, {
        error: error instanceof Error ? error.message : 'Git coordinator failure',
      });
    }
  }
  private pump(): void {
    if (this.active || this.journal.record) return;
    const entry = this.queue.shift();
    if (!entry) return;
    clearTimeout(entry.timer);
    const { request, socket } = entry;
    try {
      validate(request.snapshot!);
      const capability = randomUUID();
      const snapshot = request.snapshot!;
      this.journal.write({
        id: request.id,
        common: snapshot.common,
        worktree: snapshot.worktree,
        kind: request.kind!,
        mainPid: process.pid,
        clientPid: request.pid!,
        generation: capability,
        state: 'active',
      });
      this.active = { socket, id: request.id, capability };
      this.reply(socket, request.id, { capability });
    } catch {
      this.reply(socket, request.id, {
        error:
          'Git state changed or ownership persistence failed. Refresh and inspect the coordinator.',
      });
      this.pump();
    }
  }
  private quarantine(): void {
    if (this.journal.record) this.journal.write({ ...this.journal.record, state: 'quarantined' });
    this.active = undefined;
    for (const entry of this.queue) {
      clearTimeout(entry.timer);
      this.reply(entry.socket, entry.request.id, { error: recovery });
    }
    this.queue = [];
  }
  async close(): Promise<void> {
    if (this.active) this.quarantine();
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
export async function startBroker(): Promise<{ dispose(): void }> {
  const broker = new MutationBroker();
  try {
    await broker.listen();
    return {
      dispose: () => {
        void broker.close();
      },
    };
  } catch (error) {
    if (!['EADDRINUSE', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw error;
    validateEndpoint(directory);
    await new Promise<void>((resolve, reject) => {
      const id = randomUUID();
      const decoder = new FrameDecoder();
      const socket = createConnection(join(directory, 'broker.sock'));
      socket.setTimeout(3000, () => socket.destroy(new Error(recovery)));
      socket.once('error', reject);
      socket.once('connect', () => socket.write(encode({ version: 1, id, method: 'diagnose' })));
      socket.on('data', (chunk: Buffer) => {
        try {
          for (const value of decoder.push(chunk)) {
            const reply = value as { version: number; id: string; state: string };
            if (
              reply.version !== 1 ||
              reply.id !== id ||
              !['ready', 'active', 'quarantined'].includes(reply.state)
            )
              throw new Error('Invalid coordinator protocol');
            socket.destroy();
            resolve();
          }
        } catch (error) {
          socket.destroy();
          reject(error);
        }
      });
    });
    return { dispose() {} };
  }
}
