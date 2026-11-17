import * as vscode from 'vscode';
import { performance } from 'node:perf_hooks';

export class StorageCases {
  private readonly key = 'application-coherence.v1';
  private expected: string | undefined;
  private armed = false;
  private events = 0;
  private reads = 0;
  private failures = 0;
  private foreignStart = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly listener: vscode.Disposable;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly nonce: string,
  ) {
    this.listener = secrets.onDidChange((event) => {
      if (event.key !== this.key || !this.armed) return;
      this.events++;
      this.queue = this.queue
        .then(() => this.compare())
        .catch(() => {
          this.failures++;
        });
    });
  }

  private value(generation: number): string {
    return `storage-fixture/${this.nonce}/${generation}/λ`;
  }

  arm(generation: number, deleted: boolean): void {
    this.expected = deleted ? undefined : this.value(generation);
    this.foreignStart = this.events;
    this.armed = true;
  }

  private async compare(): Promise<void> {
    const expected = this.expected;
    const actual = await this.secrets.get(this.key);
    this.reads++;
    if (actual !== expected) {
      this.failures++;
      throw new Error('SECRET_MISMATCH');
    }
  }

  private async settled(): Promise<void> {
    await this.queue;
    if (this.failures) throw new Error('MONITORED_READ_FAILURE');
  }

  async read(): Promise<object> {
    await this.settled();
    await this.compare();
    return this.observation();
  }

  async write(generation: number, deleted: boolean): Promise<object> {
    await this.settled();
    const operation = this.queue.then(async () => {
      this.arm(generation, deleted);
      if (deleted) await this.secrets.delete(this.key);
      else await this.secrets.store(this.key, this.expected!);
      await this.compare();
    });
    this.queue = operation;
    await operation;
    await this.settled();
    return this.observation();
  }

  async ownBurst(): Promise<object> {
    for (let generation = 1; generation <= 12; generation++) {
      await this.write(generation, generation % 3 === 0);
    }
    await this.write(13, false);
    await this.write(14, false);
    await new Promise((done) => setTimeout(done, 600));
    await this.read();
    if (this.reads < 15 || this.events < 1) throw new Error('MISSING_NATIVE_OBSERVATIONS');
    return { ...this.observation(), transitions: 12, rotation: true };
  }

  async foreign(): Promise<object> {
    const deadline = performance.now() + 35000;
    while (this.events === this.foreignStart && performance.now() < deadline) {
      await new Promise((done) => setTimeout(done, 25));
    }
    if (this.events === this.foreignStart) throw new Error('FOREIGN_EVENT_DEADLINE');
    await this.settled();
    await this.compare();
    return { ...this.observation(), foreignObserved: true };
  }

  observation(): { events: number; reads: number; failures: number; equal: boolean } {
    return {
      events: this.events,
      reads: this.reads,
      failures: this.failures,
      equal: this.failures === 0,
    };
  }

  dispose(): void {
    this.listener.dispose();
  }
}
