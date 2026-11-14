import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { encode, FrameDecoder } from './framing';
import { Hello, Method, response, validateParams, validateResult } from './protocol';
type Pending = { method: Method; finish: (error?: Error, value?: unknown) => void };
export type BridgeState = 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed';
export class BridgeClient {
  state: BridgeState = 'stopped';
  generation = 0;
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<Hello>;
  private stopping?: Promise<void>;
  private closed: Promise<void> = Promise.resolve();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private writes: Promise<void> = Promise.resolve();
  private stderr = Buffer.alloc(0);
  private hello?: Hello;
  private queuedWrites = 0;
  constructor(
    private readonly executable: string,
    private readonly args: string[] = [],
  ) {}
  get pid(): number | undefined {
    return this.child?.pid;
  }
  get diagnostics() {
    return {
      state: this.state,
      generation: this.generation,
      pid: this.pid,
      pending: this.pending.size,
      stderrBytes: this.stderr.length,
      queuedWrites: this.queuedWrites,
    };
  }
  start(): Promise<Hello> {
    if (this.starting) return this.starting;
    if (this.state === 'ready') return Promise.resolve(this.hello!);
    if (this.state === 'stopping') return Promise.reject(new Error('Stopping'));
    if (this.child) return this.restart();
    this.state = 'starting';
    this.generation++;
    this.nextId = 1;
    this.stderr = Buffer.alloc(0);
    const child = spawn(this.executable, this.args, {
      shell: false,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.writes = Promise.resolve();
    const decoder = new FrameDecoder();
    this.closed = new Promise<void>((resolve) => {
      child.once('close', () => {
        if (this.child === child) {
          this.rejectAll(new Error('TransportClosed'));
          this.child = undefined;
          if (this.state !== 'stopping') this.state = 'failed';
        }
        resolve();
      });
    });
    child.on('error', () => this.fail(child, new Error('SpawnFailed')));
    child.stdin.on('error', () => this.fail(child, new Error('TransportClosed')));
    child.stderr.on('data', (chunk: Buffer) => {
      if (this.child !== child) return;
      this.stderr = Buffer.concat([this.stderr, chunk]).subarray(-4096);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child !== child) return;
      try {
        for (const value of decoder.push(chunk)) {
          const packet = response(value);
          const entry = this.pending.get(packet.id);
          if (!entry) continue;
          if (packet.error) entry.finish(new Error(`RPC:${packet.error.code}`));
          else {
            validateResult(entry.method, packet.result);
            entry.finish(undefined, packet.result);
          }
        }
      } catch {
        this.fail(child, new Error('InvalidResponse'));
      }
    });
    child.stdout.on('end', () => {
      try {
        decoder.end();
      } catch {
        this.fail(child, new Error('TruncatedFrame'));
      }
    });
    this.starting = this.request(
      'hello',
      { protocolMajor: 1, protocolMinor: 0 },
      { timeoutMs: 2000 },
    )
      .then((value) => {
        if (this.child !== child || this.state !== 'starting') throw new Error('TransportClosed');
        this.state = 'ready';
        this.hello = value as Hello;
        return this.hello;
      })
      .catch(async (error: unknown) => {
        this.fail(child, error instanceof Error ? error : new Error('StartupFailed'));
        await this.stop();
        this.state = 'failed';
        throw error;
      })
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }
  request(
    method: Method,
    params: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (!(
      this.state === 'ready' ||
      (this.state === 'starting' && method === 'hello') ||
      (this.state === 'stopping' && method === 'shutdown')
    ))
      return Promise.reject(new Error('NotReady'));
    if (this.state === 'ready' && method === 'hello')
      return Promise.reject(new Error('AlreadyInitialized'));
    try {
      validateParams(method, params);
    } catch (error) {
      return Promise.reject(error);
    }
    if (options.signal?.aborted) return Promise.reject(new Error('Cancelled'));
    if (this.pending.size >= 16 || this.nextId > 2147483647)
      return Promise.reject(new Error('Busy'));
    const timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
      return Promise.reject(new Error('InvalidTimeout'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: unknown) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(value);
      };
      const cancel = (reason: string) => {
        void this.send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } }).catch(
          () => {},
        );
        finish(new Error(reason));
      };
      const abort = () => cancel('Cancelled');
      const timer = setTimeout(() => cancel('Timeout'), timeoutMs);
      this.pending.set(id, { method, finish });
      options.signal?.addEventListener('abort', abort, { once: true });
      void this.send({ jsonrpc: '2.0', id, method, params }).catch(() =>
        finish(new Error('TransportClosed')),
      );
    });
  }
  private send(value: unknown): Promise<void> {
    const child = this.child;
    if (this.queuedWrites >= 32) {
      if (child) this.fail(child, new Error('WriteQueueFull'));
      return Promise.reject(new Error('WriteQueueFull'));
    }
    const bytes = encode(value);
    this.queuedWrites++;
    const write = this.writes.then(async () => {
      if (
        !child ||
        this.child !== child ||
        child.exitCode !== null ||
        child.signalCode !== null ||
        child.stdin.destroyed
      )
        throw new Error('TransportClosed');
      if (!child.stdin.write(bytes))
        await Promise.race([
          once(child.stdin, 'drain'),
          this.closed.then(() => {
            throw new Error('TransportClosed');
          }),
        ]);
    });
    const completed = write.finally(() => {
      this.queuedWrites--;
    });
    this.writes = completed.catch(() => {});
    return completed;
  }
  private rejectAll(error: Error): void {
    for (const entry of [...this.pending.values()]) entry.finish(error);
  }
  private fail(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.state = 'failed';
    this.rejectAll(error);
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (this.child === child && child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
    }, 250);
    void this.closed.then(() => clearTimeout(timer));
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const child = this.child;
    if (!child) {
      this.state = 'stopped';
      return Promise.resolve();
    }
    this.state = 'stopping';
    this.rejectAll(new Error('Stopped'));
    const closed = this.closed;
    const wait = async (ms: number) => {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      ]);
      clearTimeout(timer);
    };
    this.stopping = (async () => {
      try {
        await this.request('shutdown', {}, { timeoutMs: 1000 });
      } catch {}
      child.stdin.end();
      await wait(1000);
      if (this.child === child) {
        child.kill('SIGTERM');
        await wait(250);
      }
      if (this.child === child) {
        child.kill('SIGKILL');
        await wait(250);
      }
      if (this.child === child) throw new Error('CleanupDeadline');
      this.state = 'stopped';
    })().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }
  async restart(): Promise<Hello> {
    await this.stop();
    return this.start();
  }
}
