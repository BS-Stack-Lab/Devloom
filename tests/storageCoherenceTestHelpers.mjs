import { Storage } from '../vendor/code-oss/out/vs/base/parts/storage/common/storage.js';
import { Emitter } from '../vendor/code-oss/out/vs/base/common/event.js';

export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
export const tick = () => new Promise((done) => setTimeout(done, 5));
export async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('Controlled storage deadline');
}
export function database(entries = []) {
  const emitter = new Emitter();
  return {
    emitter,
    onDidChangeItemsExternal: emitter.event,
    items: new Map(entries),
    reads: 0,
    activeReads: 0,
    maximumReads: 0,
    holdRead: null,
    holdUpdate: null,
    updates: [],
    closed: false,
    async getItems() {
      this.reads++;
      this.maximumReads = Math.max(this.maximumReads, ++this.activeReads);
      const snapshot = new Map(this.items);
      try {
        return this.holdRead ? await this.holdRead.promise : snapshot;
      } finally {
        this.activeReads--;
      }
    },
    async updateItems(request) {
      this.updates.push(request);
      if (this.holdUpdate) await this.holdUpdate.promise;
      request.insert?.forEach((value, key) => this.items.set(key, value));
      request.delete?.forEach((key) => this.items.delete(key));
    },
    async optimize() {},
    async close(recovery) {
      this.closed = true;
      this.recovery = recovery();
    },
    event(changed = [], deleted = []) {
      this.emitter.fire({ changed: new Map(changed), deleted: new Set(deleted) });
    },
  };
}
export async function setup(entries, options = { reconcileExternalChanges: true }) {
  const db = database(entries);
  const storage = new Storage(db, options);
  await storage.init();
  const events = [];
  storage.onDidChangeStorage((event) => events.push({ ...event, value: storage.get(event.key) }));
  return { db, storage, events };
}
export async function finish(storage) {
  await storage.close();
  storage.dispose();
}
