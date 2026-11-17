import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from '../vendor/code-oss/out/vs/base/parts/storage/common/storage.js';
import { errorHandler } from '../vendor/code-oss/out/vs/base/common/errors.js';
import { Emitter } from '../vendor/code-oss/out/vs/base/common/event.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((done) => setTimeout(done, 5));
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('Controlled storage deadline');
}
function database(entries = []) {
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
async function setup(entries, options = { reconcileExternalChanges: true }) {
  const db = database(entries);
  const storage = new Storage(db, options);
  await storage.init();
  const events = [];
  storage.onDidChangeStorage((event) => events.push({ ...event, value: storage.get(event.key) }));
  return { db, storage, events };
}
async function finish(storage) {
  await storage.close();
  storage.dispose();
}

test('compiled actual Storage: pending own value rejects stale payload', async () => {
  const { db, storage } = await setup([['key', 'old']]);
  try {
    const write = storage.set('key', 'new');
    db.event([['key', 'old']]);
    assert.equal(storage.get('key'), 'new');
    await write;
    assert.equal(storage.get('key'), 'new');
  } finally {
    await finish(storage);
  }
});

test('inflight insert and delete retain intent until ACK then admit genuine foreign state', async () => {
  const { db, storage, events } = await setup([['key', 'old']]);
  try {
    db.holdUpdate = deferred();
    const write = storage.set('key', 'new');
    await until(() => db.updates.length === 1);
    const before = db.reads;
    db.event([['key', 'old']]);
    assert.equal(storage.get('key'), 'new');
    assert.equal(db.reads, before);
    db.holdUpdate.resolve();
    await write;
    db.holdUpdate = null;
    assert.equal(storage.get('key'), 'new');
    db.items.set('key', 'foreign');
    db.event([['key', 'ignored']]);
    await until(() => storage.get('key') === 'foreign');
    assert.ok(events.some((event) => event.external && event.value === 'foreign'));
    db.holdUpdate = deferred();
    const deletion = storage.delete('key');
    await until(() => db.updates.length === 2);
    db.event([['key', 'foreign']]);
    assert.equal(storage.get('key'), undefined);
    db.holdUpdate.resolve();
    await deletion;
    db.holdUpdate = null;
    db.event([['key', 'foreign']]);
    await storage.flush(0);
    assert.equal(storage.get('key'), undefined);
  } finally {
    db.holdUpdate?.resolve();
    await finish(storage);
  }
});

test('arbitrarily delayed payloads and ABA never replay historical values', async () => {
  const { db, storage } = await setup([['key', 'a']]);
  try {
    for (const value of ['b', 'a', 'c']) {
      await storage.set('key', value);
      db.event([['key', 'a']]);
      await storage.flush(0);
      assert.equal(storage.get('key'), value);
    }
    db.items.delete('key');
    db.event([], ['unrelated']);
    await storage.flush(0);
    assert.equal(storage.get('key'), undefined);
  } finally {
    await finish(storage);
  }
});

test('read generations discard stale snapshots and coalesce invalidation bursts', async () => {
  const { db, storage } = await setup([
    ['key', 'a'],
    ['gone', 'old'],
  ]);
  try {
    const reference = storage.items;
    const held = (db.holdRead = deferred());
    db.event([['key', 'old']]);
    await until(() => db.activeReads === 1);
    for (let i = 0; i < 1000; i++) db.event([['key', 'untrusted']]);
    db.items.set('key', 'current');
    db.items.delete('gone');
    db.holdRead = null;
    held.resolve(new Map([['key', 'obsolete']]));
    await storage.flush(0);
    assert.equal(storage.items, reference);
    assert.deepEqual([...storage.items], [['key', 'current']]);
    assert.equal(db.maximumReads, 1);
    assert.ok(db.reads <= 3);
    assert.equal(storage.reconciliation, undefined);
    assert.equal(storage.activeUpdate, undefined);
  } finally {
    db.holdRead?.resolve(new Map());
    await finish(storage);
  }
});

test('a write during a read ends that reader without waiting for a queued flush', async () => {
  const { db, storage } = await setup([['key', 'a']]);
  try {
    const held = (db.holdRead = deferred());
    db.event([['key', 'obsolete']]);
    await until(() => db.activeReads === 1);
    const write = storage.set('key', 'b');
    db.holdRead = null;
    held.resolve(new Map([['key', 'a']]));
    await write;
    await storage.flush(0);
    assert.equal(storage.get('key'), 'b');
    assert.equal(db.maximumReads, 1);
  } finally {
    db.holdRead?.resolve(new Map());
    await finish(storage);
  }
});

test('held initialization waits for own ACK and retains untouched authoritative keys', async () => {
  const db = database([
    ['key', 'old'],
    ['other', 'initial'],
  ]);
  db.holdRead = deferred();
  db.holdUpdate = deferred();
  const storage = new Storage(db, { reconcileExternalChanges: true });
  const initialization = storage.init();
  let initialized = false;
  void initialization.then(() => {
    initialized = true;
  });
  const write = storage.set('key', 'new');
  db.event([['key', 'stale']]);
  db.holdRead.resolve(
    new Map([
      ['key', 'old'],
      ['other', 'initial'],
    ]),
  );
  db.holdRead = null;
  await until(() => db.updates.length === 1);
  assert.equal(initialized, false);
  assert.equal(storage.get('key'), 'new');
  db.holdUpdate.resolve();
  db.holdUpdate = null;
  await initialization;
  assert.equal(storage.get('other'), 'initial');
  assert.equal(storage.get('key'), 'new');
  await write;
  await finish(storage);
});

test('initial read finishing after own ACK cannot overwrite local value or tombstone', async () => {
  for (const operation of ['set', 'delete']) {
    const db = database([['key', 'old']]);
    const storage = new Storage(db, { reconcileExternalChanges: true });
    if (operation === 'delete') await storage.set('key', 'old');
    const held = (db.holdRead = deferred());
    const initialization = storage.init();
    await (operation === 'set' ? storage.set('key', 'new') : storage.delete('key'));
    db.holdRead = null;
    held.resolve(new Map([['key', 'old']]));
    await initialization;
    assert.equal(storage.get('key'), operation === 'set' ? 'new' : undefined);
    await finish(storage);
  }
});

test('failed updates retain inserts and tombstones without retry and newer pending operation wins', async () => {
  const { db, storage } = await setup([
    ['delete', 'old'],
    ['newer', 'old'],
  ]);
  try {
    db.holdUpdate = deferred();
    const writes = [
      storage.set('key', 'first'),
      storage.delete('delete'),
      storage.set('newer', 'failed'),
    ];
    writes.forEach((promise) => void promise.catch(() => {}));
    await until(() => db.updates.length === 1);
    const newer = storage.delete('newer');
    void newer.catch(() => {});
    const failed = db.holdUpdate;
    db.holdUpdate = null;
    failed.reject(new Error('synthetic-update'));
    await assert.rejects(writes[0], /synthetic-update/);
    assert.equal(storage.get('key'), 'first');
    assert.equal(storage.get('delete'), undefined);
    await storage.flush(0);
    await newer;
    assert.deepEqual([...db.items], [['key', 'first']]);
    assert.equal(storage.activeUpdate, undefined);
  } finally {
    db.holdUpdate?.resolve();
    await finish(storage);
  }
});

test('failed update does not signal whenFlushed success or reconcile unacknowledged intent', async () => {
  const { db, storage } = await setup([['key', 'old']]);
  try {
    db.holdUpdate = deferred();
    const write = storage.set('key', 'new');
    void write.catch(() => {});
    await until(() => db.updates.length === 1);
    let flushed = false;
    const waiter = storage.whenFlushed().then(() => {
      flushed = true;
    });
    db.event([['key', 'old']]);
    db.holdUpdate.reject(new Error('synthetic-update'));
    await assert.rejects(write);
    db.holdUpdate = null;
    await tick();
    assert.equal(flushed, false);
    assert.equal(db.updates.length, 1);
    assert.equal(db.reads, 1);
    await storage.flush(0);
    await waiter;
    assert.equal(storage.get('key'), 'new');
  } finally {
    db.holdUpdate?.resolve();
    await finish(storage);
  }
});

test('failed reconciliation rejects initiating flush, keeps cache and permits explicit recovery', async () => {
  const { db, storage } = await setup([['key', 'old']]);
  try {
    db.holdUpdate = deferred();
    const write = storage.set('key', 'new');
    void write.catch(() => {});
    await until(() => db.updates.length === 1);
    const held = (db.holdRead = deferred());
    db.event([['key', 'old']]);
    db.holdUpdate.resolve();
    await until(() => db.activeReads === 1);
    held.reject(new Error('synthetic-read'));
    await assert.rejects(write, /synthetic-read/);
    db.holdRead = null;
    db.holdUpdate = null;
    assert.equal(storage.get('key'), 'new');
    await storage.flush(0);
    assert.equal(storage.get('key'), 'new');
  } finally {
    db.holdRead?.resolve(new Map());
    db.holdUpdate?.resolve();
    await finish(storage);
  }
});

test('external snapshot batch is coherent before reentrant callbacks mutate it', async () => {
  const { db, storage } = await setup([
    ['a', 'old'],
    ['b', 'old'],
  ]);
  let write;
  storage.onDidChangeStorage((event) => {
    if (event.external && event.key === 'a') {
      assert.equal(storage.get('b'), 'foreign');
      write = storage.set('b', 'local');
    }
  });
  db.items.set('a', 'foreign');
  db.items.set('b', 'foreign');
  db.event([['a', 'ignored']]);
  await until(() => Boolean(write));
  await write;
  await storage.flush(0);
  assert.equal(storage.get('b'), 'local');
  await finish(storage);
});

test('close and dispose discard late reads and close always receives recovery cache', async () => {
  for (const action of ['close', 'dispose']) {
    const { db, storage } = await setup([['key', 'current']]);
    const held = (db.holdRead = deferred());
    db.event([['key', 'ignored']]);
    await until(() => db.activeReads === 1);
    if (action === 'close') await storage.close();
    else storage.dispose();
    held.resolve(new Map([['key', 'late']]));
    await tick();
    assert.equal(storage.get('key'), 'current');
    if (action === 'close') assert.equal(db.closed, true);
    storage.dispose();
  }
  const { db, storage } = await setup([['key', 'old']]);
  db.holdUpdate = deferred();
  const write = storage.set('key', 'new');
  void write.catch(() => {});
  await until(() => db.updates.length === 1);
  db.holdUpdate.reject(new Error('synthetic-close'));
  await assert.rejects(write);
  const closing = storage.close();
  await until(() => db.updates.length === 2);
  await closing;
  assert.equal(db.closed, true);
  assert.equal(db.recovery.get('key'), 'new');
  storage.dispose();
});

test('unconfigured callers preserve upstream direct external event semantics', async () => {
  const { db, storage, events } = await setup([['key', 'original']], {});
  db.event([['key', 'payload']]);
  assert.equal(storage.get('key'), 'payload');
  assert.equal(db.reads, 1);
  assert.deepEqual(events, [{ key: 'key', external: true, value: 'payload' }]);
  await finish(storage);
});

test('event burst uses a single error handler and a later event can recover read failure', async () => {
  const { db, storage } = await setup([['key', 'current']]);
  const previous = errorHandler.getUnexpectedErrorHandler();
  const errors = [];
  errorHandler.setUnexpectedErrorHandler((error) => errors.push(error));
  try {
    const held = (db.holdRead = deferred());
    db.event([['key', 'old']]);
    for (let i = 0; i < 1000; i++) db.event([['key', 'old']]);
    held.reject(new Error('synthetic-event-read'));
    await until(() => errors.length > 0);
    await tick();
    assert.equal(errors.length, 1);
    assert.equal(storage.get('key'), 'current');
    assert.equal(db.reads, 2);
    assert.equal(storage.reconciliation, undefined);
    db.holdRead = null;
    db.items.set('key', 'foreign');
    db.event([['key', 'ignored']]);
    await storage.flush(0);
    assert.equal(storage.get('key'), 'foreign');
  } finally {
    db.holdRead?.resolve(new Map());
    errorHandler.setUnexpectedErrorHandler(previous);
    await finish(storage);
  }
});

test('late initial snapshots after close or dispose never install and init errors preserve local intent', async () => {
  for (const action of ['close', 'dispose', 'reject']) {
    const db = database([['key', 'old']]);
    const held = (db.holdRead = deferred());
    const storage = new Storage(db, { reconcileExternalChanges: true });
    const initializing = storage.init();
    void initializing.catch(() => {});
    const write = storage.set('key', 'current');
    void write.catch(() => {});
    if (action === 'reject') {
      held.reject(new Error('synthetic-init'));
      await assert.rejects(initializing);
      db.holdRead = null;
      await write;
      await storage.flush(0);
    } else {
      if (action === 'close') await storage.close();
      else storage.dispose();
      held.resolve(new Map([['key', 'obsolete']]));
      await initializing;
      if (action === 'close') await write;
    }
    assert.equal(storage.get('key'), 'current');
    storage.dispose();
  }
});

test('a factory queued before failure cannot automatically retry restored intent', async () => {
  for (const newerDelete of [false, true]) {
    const { db, storage } = await setup([['x', 'old']]);
    try {
      db.holdUpdate = deferred();
      const first = storage.set('x', 'new');
      void first.catch(() => {});
      await until(() => db.updates.length === 1);
      const newer = newerDelete ? storage.delete('x') : storage.set('y', 'newer');
      void newer.catch(() => {});
      await new Promise((done) => setTimeout(done, 120));
      assert.equal(db.updates.length, 1);
      db.holdUpdate.reject(new Error('synthetic-queued-failure'));
      await assert.rejects(first, /synthetic-queued-failure/);
      await assert.rejects(newer, /explicit retry/);
      db.holdUpdate = null;
      assert.equal(db.updates.length, 1);
      assert.equal(storage.get('x'), newerDelete ? undefined : 'new');
      let flushed = false;
      const waiter = storage.whenFlushed().then(() => {
        flushed = true;
      });
      await tick();
      assert.equal(flushed, false);
      await storage.set('x', newerDelete ? undefined : 'new');
      assert.equal(db.updates.length, 1);
      await storage.flush(0);
      await waiter;
      assert.deepEqual(
        [...db.items],
        newerDelete
          ? []
          : [
              ['x', 'new'],
              ['y', 'newer'],
            ],
      );
      assert.equal(db.updates.length, 2);
    } finally {
      db.holdUpdate?.resolve();
      await finish(storage);
    }
  }
});

test('initialization cannot clear a failed-write guard or retry retained intent', async () => {
  const db = database([['key', 'old']]);
  const held = (db.holdRead = deferred());
  db.holdUpdate = deferred();
  const storage = new Storage(db, { reconcileExternalChanges: true });
  const initializing = storage.init();
  void initializing.catch(() => {});
  const write = storage.set('key', 'current');
  void write.catch(() => {});
  await until(() => db.updates.length === 1);
  db.holdUpdate.reject(new Error('synthetic-init-write'));
  await assert.rejects(write);
  db.holdUpdate = null;
  db.holdRead = null;
  held.resolve(new Map([['key', 'old']]));
  await assert.rejects(initializing, /explicit retry/);
  assert.equal(db.updates.length, 1);
  assert.equal(storage.get('key'), 'current');
  await storage.flush(0);
  assert.equal(db.items.get('key'), 'current');
  await finish(storage);
});
