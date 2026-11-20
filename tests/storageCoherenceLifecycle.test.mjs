import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from '../vendor/code-oss/out/vs/base/parts/storage/common/storage.js';
import { errorHandler } from '../vendor/code-oss/out/vs/base/common/errors.js';
import { deferred, database, setup, finish, tick, until } from './storageCoherenceTestHelpers.mjs';

test('failed write barrier survives ordinary set and delete until explicit flush', async () => {
  const { db, storage } = await setup([['remove', 'present']]);
  try {
    db.holdUpdate = deferred();
    const failedWrite = storage.set('failed', 'retained');
    void failedWrite.catch(() => {});
    await until(() => db.updates.length === 1);
    db.holdUpdate.reject(new Error('synthetic-update'));
    await assert.rejects(failedWrite, /synthetic-update/);
    db.holdUpdate = null;

    const scheduled = [];
    const trigger = storage.flushDelayer.trigger.bind(storage.flushDelayer);
    storage.flushDelayer.trigger = (task) => {
      scheduled.push(task);
      return Promise.resolve();
    };
    await storage.set('later', 'value');
    await storage.delete('remove');
    for (const task of scheduled) {
      await assert.rejects(task(), /explicit retry/);
    }
    assert.equal(db.updates.length, 1);

    storage.flushDelayer.trigger = trigger;
    await storage.flush(0);
    assert.equal(db.updates.length, 2);
    assert.equal(db.items.get('failed'), 'retained');
    assert.equal(db.items.get('later'), 'value');
    assert.equal(db.items.has('remove'), false);
  } finally {
    db.holdUpdate?.resolve();
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

test('failed detached reconciliation reports asynchronously and permits explicit recovery', async () => {
  const { db, storage } = await setup([['key', 'old']]);
  const previousHandler = errorHandler.getUnexpectedErrorHandler();
  const reported = [];
  errorHandler.setUnexpectedErrorHandler((error) => reported.push(error.message));
  try {
    db.holdUpdate = deferred();
    const write = storage.set('key', 'new');
    await until(() => db.updates.length === 1);
    const held = (db.holdRead = deferred());
    db.event([['key', 'old']]);
    db.holdUpdate.resolve();
    await until(() => db.activeReads === 1);
    await write;
    held.reject(new Error('synthetic-read'));
    await until(() => reported.includes('synthetic-read'));
    db.holdRead = null;
    db.holdUpdate = null;
    assert.equal(storage.get('key'), 'new');
    await storage.flush(0);
    assert.equal(storage.get('key'), 'new');
  } finally {
    errorHandler.setUnexpectedErrorHandler(previousHandler);
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
