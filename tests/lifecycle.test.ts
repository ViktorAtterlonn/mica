import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MongoClient } from 'mongodb';
import { collection, createDatabase, string } from '../src/index.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
test('connect waits for ping, coalesces concurrent calls, and failed connection can be retried', async (t) => {
  const client = new MongoClient('mongodb://127.0.0.1:1');
  const ping = deferred();
  let attempts = 0;
  const events: string[] = [];
  t.mock.method(client, 'connect', async () => {
    attempts++;
    return client;
  });
  t.mock.method(client, 'db', () => ({ command: () => ping.promise }));
  t.mock.method(client, 'close', async () => {});
  const db = createDatabase({
    client,
    database: 'test',
    collections: {},
    events: { connected: () => events.push('connected'), error: () => events.push('error') },
  });
  const a = db.connect();
  const b = db.connect();
  assert.equal(a, b);
  await Promise.resolve();
  assert.equal(db.status, 'connecting');
  assert.deepEqual(events, []);
  ping.reject(new Error('ping denied'));
  await assert.rejects(a, /ping denied/);
  assert.equal(db.status, 'disconnected');
  assert.deepEqual(events, ['error']);
  t.mock.method(client, 'db', () => ({ command: async () => ({ ok: 1 }) }));
  await db.connect();
  assert.equal(db.status, 'connected');
  assert.equal(attempts, 2);
  assert.deepEqual(events, ['error', 'connected']);
  await db.close();
});
test('close during connect prevents a late connected callback and closes once', async (t) => {
  const client = new MongoClient('mongodb://127.0.0.1:1');
  const connecting = deferred();
  let closes = 0;
  t.mock.method(client, 'connect', () => connecting.promise.then(() => client));
  t.mock.method(client, 'db', () => ({ command: async () => ({ ok: 1 }) }));
  t.mock.method(client, 'close', async () => {
    closes++;
  });
  const db = createDatabase({
    client,
    database: 'test',
    collections: {},
    events: { connected: () => assert.fail('late connected callback') },
  });
  const pending = db.connect();
  const closing = db.close();
  assert.equal(db.status, 'closing');
  assert.equal(closing, db.close());
  await assert.rejects(db.connect(), /closing/);
  connecting.resolve();
  await Promise.all([pending, closing]);
  assert.equal(db.status, 'closed');
  assert.equal(closes, 1);
  assert.equal(client.listenerCount('topologyClosed'), 0);
});
test('callback exceptions reach error callback without corrupting lifecycle', async (t) => {
  const client = new MongoClient('mongodb://127.0.0.1:1');
  t.mock.method(client, 'connect', async () => client);
  t.mock.method(client, 'db', () => ({ command: async () => ({ ok: 1 }) }));
  t.mock.method(client, 'close', async () => {});
  const errors: Error[] = [];
  const db = createDatabase({
    client,
    database: 'test',
    collections: {},
    events: {
      connected() {
        throw new Error('callback failed');
      },
      error(error) {
        errors.push(error);
        throw new Error('ignored');
      },
    },
  });
  await db.connect();
  assert.equal(db.status, 'connected');
  assert.equal(errors[0]!.message, 'callback failed');
  await db.close();
  assert.equal(db.status, 'closed');
});
test('close before connect is terminal', async () => {
  const db = createDatabase({ uri: 'mongodb://127.0.0.1:1', database: 'test', collections: {} });
  await db.close();
  assert.equal(db.status, 'closed');
  await assert.rejects(db.connect(), /closed/);
});
test('replica-set primary loss disconnects; losing only a secondary does not; recovery requires ping', async (t) => {
  const client = new MongoClient('mongodb://127.0.0.1:1');
  t.mock.method(client, 'connect', async () => client);
  t.mock.method(client, 'db', () => ({ command: async () => ({ ok: 1 }) }));
  t.mock.method(client, 'close', async () => {});
  const events: string[] = [];
  const db = createDatabase({
    client,
    database: 'test',
    collections: {},
    events: {
      connected: () => events.push('connected'),
      disconnected: () => events.push('disconnected'),
      reconnected: () => events.push('reconnected'),
    },
  });
  await db.connect();
  const topology = (...types: string[]) =>
    client.emit('topologyDescriptionChanged', {
      newDescription: {
        type: types.includes('RSPrimary') ? 'ReplicaSetWithPrimary' : 'ReplicaSetNoPrimary',
        servers: new Map(types.map((type, i) => [String(i), { type }])),
      },
    } as never);
  topology('RSPrimary', 'Unknown');
  assert.equal(db.status, 'connected');
  topology('Unknown', 'RSSecondary');
  topology('Unknown', 'RSSecondary');
  assert.deepEqual(events, ['connected', 'disconnected']);
  const ping = deferred();
  t.mock.method(client, 'db', () => ({ command: () => ping.promise }));
  topology('RSPrimary', 'RSSecondary');
  assert.equal(db.status, 'disconnected');
  ping.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(db.status, 'connected');
  assert.deepEqual(events, ['connected', 'disconnected', 'reconnected']);
  await db.close();
});
test('a successful late recovery ping cannot reconnect a closed database', async (t) => {
  const client = new MongoClient('mongodb://127.0.0.1:1');
  t.mock.method(client, 'connect', async () => client);
  t.mock.method(client, 'db', () => ({ command: async () => ({ ok: 1 }) }));
  t.mock.method(client, 'close', async () => {});
  const db = createDatabase({
    client,
    database: 'test',
    collections: {},
    events: { reconnected: () => assert.fail('late recovery') },
  });
  await db.connect();
  client.emit('topologyClosed', {} as never);
  const ping = deferred();
  t.mock.method(client, 'db', () => ({ command: () => ping.promise }));
  client.emit('topologyDescriptionChanged', {
    newDescription: { type: 'Single', servers: new Map([['one', { type: 'Standalone' }]]) },
  } as never);
  await db.close();
  ping.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(db.status, 'closed');
});

test('temporary topology loss preserves native operation errors after connecting', async (t) => {
  const client = new MongoClient('mongodb://127.0.0.1:1');
  const nativeError = new Error('native transient error');
  let nativeCalls = 0;
  t.mock.method(client, 'connect', async () => client);
  t.mock.method(client, 'close', async () => {});
  t.mock.method(client, 'db', () => ({
    command: async () => ({ ok: 1 }),
    collection: () => ({
      findOne: async () => {
        nativeCalls++;
        throw nativeError;
      },
    }),
  }));
  const Records = collection('records', { _id: string() });
  const db = createDatabase({ client, database: 'test', collections: { records: Records } });
  await assert.rejects(db.records.findOne({}), /Call db.connect/);
  assert.equal(nativeCalls, 0);
  await db.connect();
  client.emit('topologyDescriptionChanged', {
    newDescription: {
      type: 'ReplicaSetNoPrimary',
      servers: new Map([['one', { type: 'Unknown' }]]),
    },
  } as never);
  assert.equal(db.status, 'disconnected');
  await assert.rejects(db.records.findOne({}), (error) => error === nativeError);
  assert.equal(nativeCalls, 1);
  const session = db.startSession();
  await session.endSession();
  await db.close();
  await assert.rejects(db.records.findOne({}), /closed/);
  assert.throws(() => db.startSession(), /closed/);
  assert.equal(nativeCalls, 1);
});
