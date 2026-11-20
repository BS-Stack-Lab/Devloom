import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from '../vendor/code-oss/out/vs/base/parts/storage/common/storage.js';
import { deferred, database, setup, finish, tick, until } from './storageCoherenceTestHelpers.mjs';

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

test('post-ACK reconciliation read does not block a later update or close', async () => {
  const { db, storage, events } = await setup([
    ['key', 'old'],
    ['other', 'present'],
  ]);
  try {
    let triggerSettled = false;
    const trigger = storage.flushDelayer.trigger.bind(storage.flushDelayer);
    storage.flushDelayer.trigger = (...args) =>
      trigger(...args).then((value) => {
        triggerSettled = true;
        return value;
      });
    const readTriggerStates = [];
    const getItems = db.getItems.bind(db);
    db.getItems = (...args) => {
      readTriggerStates.push(triggerSettled);
      return getItems(...args);
    };
    let firstSettled = false;
    const held = (db.holdRead = deferred());
    db.holdUpdate = deferred();
    const first = storage.set('key', 'own');
    void first.then(() => {
      firstSettled = true;
    });
    await until(() => db.updates.length === 1);
    db.event([['key', 'stale-payload']]);
    db.holdUpdate.resolve();
    db.holdUpdate = null;
    await until(() => db.activeReads === 1);
    await until(() => firstSettled);
    assert.ok(readTriggerStates.length > 0);
    assert.equal(readTriggerStates[0], true);
    await storage.flush(0);

    const second = storage.set('key', 'newer');
    await until(() => db.updates.length === 2);
    await second;
    await storage.close();
    assert.equal(db.closed, true);

    const eventCount = events.length;
    held.resolve(
      new Map([
        ['key', 'obsolete'],
        ['other', 'stale'],
      ]),
    );
    await until(() => db.activeReads === 0);
    await tick();
    assert.equal(storage.get('key'), 'newer');
    assert.equal(storage.get('other'), 'present');
    assert.equal(events.length, eventCount);
    assert.equal(
      events.some((event) => event.external),
      false,
    );
  } finally {
    db.holdRead?.resolve(new Map());
    db.holdUpdate?.resolve();
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
    const db = database([
      ['key', 'old'],
      ['other', 'retained'],
    ]);
    const storage = new Storage(db, { reconcileExternalChanges: true });
    if (operation === 'delete') await storage.set('key', 'old');
    const held = (db.holdRead = deferred());
    const initialization = storage.init();
    await (operation === 'set' ? storage.set('key', 'new') : storage.delete('key'));
    db.holdRead = null;
    held.resolve(
      new Map([
        ['key', 'old'],
        ['other', 'stale'],
      ]),
    );
    await initialization;
    assert.equal(storage.get('key'), operation === 'set' ? 'new' : undefined);
    assert.equal(storage.get('other'), 'retained');
    await finish(storage);
  }
});
