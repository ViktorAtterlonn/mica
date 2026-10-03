import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { MongoClient } from 'mongodb';
import {
  array,
  collection,
  createDatabase,
  customType,
  date,
  index,
  jsonSchema,
  number,
  object,
  objectId,
  string,
} from '../src/index.js';

const uri = process.env.MICA_TEST_URI;
if (!uri) throw new Error('Use npm run test:integration for an isolated MongoDB container');

test('distinct uses native value semantics with typed paths and codec restrictions', async (t) => {
  let decodes = 0;
  const secret = customType({
    base: string,
    codec: {
      encode: (value: string) => `stored:${value}`,
      decode: (value: string) => {
        decodes++;
        return value.slice(7);
      },
      storedSchema: { bsonType: 'string' },
    },
  });
  const Records = collection('distinct_records', {
    _id: objectId().auto(),
    group: string(),
    optional: string().optional(),
    nullable: string().nullable().optional(),
    hidden: string(),
    tags: array(string()),
    profile: object({ label: string(), hidden: string() }),
    rows: array(object({ label: string().optional(), tags: array(string()) })),
    matrix: array(array(number())),
    secret: secret(),
    secrets: array(secret()),
    protected: object({ label: string(), secret: secret() }),
    deep: array(array(array(object({ child: object({ value: string() }) })))),
  });
  const client = new MongoClient(uri, { monitorCommands: true });
  const commands: string[] = [];
  client.on('commandStarted', ({ commandName }) => commands.push(commandName));
  const db = createDatabase({
    client,
    database: 'mica_distinct',
    collections: { records: Records },
  });
  t.after(() => db.close());
  await db.connect();
  const base = {
    hidden: 'hidden',
    tags: ['a', 'a', 'b'],
    profile: { label: 'person', hidden: 'nested hidden' },
    rows: [{ label: 'first', tags: ['x', 'y'] }, { tags: ['y', 'z'] }],
    matrix: [[1, 2], [1, 2], [3]],
    secret: 'secret',
    secrets: ['secret'],
    protected: { label: 'safe', secret: 'secret' },
    deep: [],
  };
  await db.records.insertMany([
    { ...base, group: 'a', optional: 'present', nullable: null },
    { ...base, group: 'a', nullable: 'value' },
    { ...base, group: 'b', optional: 'other' },
  ]);
  assert.deepEqual(await db.records.distinct('optional', { group: 'a' }), ['present']);
  assert.deepEqual(await db.records.distinct('optional', { group: 'missing' }), []);
  assert.deepEqual(new Set(await db.records.distinct('nullable')), new Set([null, 'value']));
  assert.deepEqual(new Set(await db.records.distinct('tags')), new Set(['a', 'b']));
  assert.deepEqual(await db.records.distinct('rows.label'), ['first']);
  assert.deepEqual(new Set(await db.records.distinct('rows.tags')), new Set(['x', 'y', 'z']));
  assert.deepEqual(await db.records.distinct('matrix'), [[1, 2], [3]]);
  assert.deepEqual(await db.records.distinct('hidden'), ['hidden']);
  assert.deepEqual(await db.records.distinct('profile'), [
    { label: 'person', hidden: 'nested hidden' },
  ]);
  assert.deepEqual(await db.records.distinct('protected.label', { secret: { $exists: true } }), [
    'safe',
  ]);
  assert.equal((await db.records.distinct('_id')).length, 3);
  assert.equal(decodes, 0);

  commands.length = 0;
  for (const path of [
    'secret',
    'secrets',
    'protected',
    'protected.secret',
    'typo',
    'rows.0.label',
    'deep.child.value',
    1,
    null,
  ]) {
    await assert.rejects(db.records.distinct(path as never));
  }
  await assert.rejects(db.records.distinct('group', { secret: 'secret' }), /codec/);
  await assert.rejects(db.records.distinct('group', { typo: 'x' } as never));
  assert.equal(commands.filter((name) => name === 'distinct').length, 0);
  await db.close();
  await assert.rejects(db.records.distinct('group'), /connect/);
});

test(
  'TTL indexes install explicitly and MongoDB expires only eligible documents',
  { timeout: 90_000 },
  async (t) => {
    const Events = collection(
      'events',
      {
        _id: objectId().auto(),
        name: string(),
        state: string(),
        expiresAt: date().optional().nullable(),
      },
      (f) => [
        index('published_expiration')
          .on(f.expiresAt)
          .expireAfterSeconds(0)
          .partial({ state: 'published' }),
      ],
    );
    const ArrayEvents = collection(
      'array_events',
      {
        _id: objectId().auto(),
        name: string(),
        dates: array(date()),
      },
      (f) => [index('date_expiration').on(f.dates).expireAfterSeconds(60)],
    );
    const client = new MongoClient(uri, { monitorCommands: true });
    const commands: string[] = [];
    client.on('commandStarted', ({ commandName }) => commands.push(commandName));
    const db = createDatabase({
      client,
      database: 'mica_ttl',
      collections: { events: Events, arrays: ArrayEvents },
    });
    let oldInterval: number | undefined;
    t.after(async () => {
      try {
        if (oldInterval !== undefined)
          await client.db('admin').command({ setParameter: 1, ttlMonitorSleepSecs: oldInterval });
      } finally {
        await db.close();
      }
    });
    await db.connect();
    assert(!commands.includes('createIndexes'));
    const native = client.db('mica_ttl');
    await native.createCollection('events', { validator: jsonSchema(Events) });
    await native.createCollection('array_events', { validator: jsonSchema(ArrayEvents) });
    await native.collection('events').createIndexes(Events.$indexes);
    await native.collection('array_events').createIndexes(ArrayEvents.$indexes);
    const installed = (await native.collection('events').listIndexes().toArray()).find(
      ({ name }) => name === 'published_expiration',
    )!;
    assert.deepEqual(installed.key, { expiresAt: 1 });
    assert.equal(installed.expireAfterSeconds, 0);
    assert.deepEqual(installed.partialFilterExpression, { state: 'published' });
    const past = new Date(Date.now() - 120_000);
    const future = new Date(Date.now() + 3_600_000);
    await db.events.insertMany([
      { name: 'expired', state: 'published', expiresAt: past },
      { name: 'future', state: 'published', expiresAt: future },
      { name: 'draft', state: 'draft', expiresAt: past },
      { name: 'missing', state: 'published' },
      { name: 'null', state: 'published', expiresAt: null },
    ]);
    await db.arrays.insertMany([
      { name: 'earliest expired', dates: [future, past] },
      { name: 'recent', dates: [new Date()] },
      { name: 'empty', dates: [] },
    ]);
    // Accelerate the monitor only inside this disposable container; restore afterwards.
    oldInterval = (await client.db('admin').command({ setParameter: 1, ttlMonitorSleepSecs: 1 }))
      .was;
    const deadline = Date.now() + 45_000;
    while (
      (await db.events.exists({ name: 'expired' })) ||
      (await db.arrays.exists({ name: 'earliest expired' }))
    ) {
      assert(Date.now() < deadline, 'TTL monitor did not expire eligible documents');
      await setTimeout(100);
    }
    assert.deepEqual(
      new Set(await db.events.distinct('name')),
      new Set(['future', 'draft', 'missing', 'null']),
    );
    assert.deepEqual(new Set(await db.arrays.distinct('name')), new Set(['recent', 'empty']));
  },
);
