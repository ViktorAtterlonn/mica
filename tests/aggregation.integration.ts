import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Binary, MongoClient, MongoServerError, ObjectId, type Document } from 'mongodb';
import {
  array,
  collection,
  createDatabase,
  customType,
  map,
  MicaValidationError,
  number,
  object,
  objectId,
  string,
} from '../src/index.js';

const uri = process.env.MICA_TEST_URI;
if (!uri) throw new Error('Use npm run test:integration for an isolated MongoDB container');

test('aggregation groups, filters, projects and paginates with native MongoDB semantics', async (t) => {
  const Sales = collection('sales', {
    _id: objectId().auto(),
    category: string(),
    amount: number().optional().nullable(),
    profile: object({ label: string() }).optional().nullable(),
  });
  const client = new MongoClient(uri, { monitorCommands: true });
  const commands: Document[] = [];
  client.on('commandStarted', (event) => {
    if (event.commandName === 'aggregate') commands.push(event.command);
  });
  const db = createDatabase({
    client,
    database: 'mica_aggregation',
    collections: { sales: Sales },
  });
  t.after(() => db.close());
  await db.connect();
  await db.sales.insertMany([
    { category: 'a', amount: 10, profile: { label: 'one' } },
    { category: 'a', amount: 20, profile: { label: 'one' } },
    { category: 'b', amount: 4, profile: null },
    { category: 'b', amount: null },
    { category: 'c' },
  ]);
  const grouped = db.sales
    .aggregate({ allowDiskUse: true, batchSize: 1, timeoutMS: 5000, maxTimeMS: 2000 })
    .group({
      _id: '$category',
      total: { $sum: '$amount' },
      count: { $sum: 1 },
      average: { $avg: '$amount' },
      min: { $min: '$amount' },
      max: { $max: '$amount' },
    });
  assert.deepEqual(await grouped.sort({ _id: 1 }).toArray(), [
    { _id: 'a', total: 30, count: 2, average: 15, min: 10, max: 20 },
    { _id: 'b', total: 4, count: 2, average: 4, min: 4, max: 4 },
    { _id: 'c', total: 0, count: 1, average: null, min: null, max: null },
  ]);
  assert.equal(commands.at(-1)!.allowDiskUse, true);
  assert.equal(commands.at(-1)!.cursor.batchSize, 1);
  assert(commands.at(-1)!.maxTimeMS > 0);
  assert.deepEqual(
    await grouped
      .match({ total: { $gt: 0 } })
      .sort({ total: -1 })
      .skip(1)
      .limit(1)
      .project({ total: 1, _id: 0 })
      .toArray(),
    [{ total: 4 }],
  );
  assert.deepEqual(
    await grouped
      .project({ total: 1, _id: 0 })
      .group({ _id: null, total: { $sum: '$total' } })
      .toArray(),
    [{ _id: null, total: 34 }],
  );
  assert.deepEqual(
    await db.sales.aggregate().match({ category: 'missing' }).count('total').toArray(),
    [],
  );
  assert.deepEqual(
    await db.sales.aggregate().count('total').match({ total: 5 }).project({ total: 1 }).toArray(),
    [{ total: 5 }],
  );
  assert.deepEqual(
    await db.sales
      .aggregate()
      .group({ _id: '$profile.label', count: { $sum: 1 } })
      .sort({ _id: 1 })
      .toArray(),
    [
      { _id: null, count: 3 },
      { _id: 'one', count: 2 },
    ],
  );
  assert.equal((await db.sales.aggregate().skip(0).project({}).toArray()).length, 5);
  assert.deepEqual(
    await db.sales
      .aggregate()
      .match({ category: 'c' })
      .group({ _id: null, total: { $sum: 2 } })
      .toArray(),
    [{ _id: null, total: 2 }],
  );
  await assert.rejects(db.sales.aggregate({ hint: 'nonexistent' }).toArray(), MongoServerError);
});

test('aggregation returns all fields by default and decodes only surviving projected fields', async (t) => {
  let decodes = 0;
  const encrypted = customType({
    base: string,
    codec: {
      encode: (value: string) => new Binary(Buffer.from(value)),
      decode: (value: Binary) => {
        decodes++;
        return value.toString();
      },
      storedSchema: { bsonType: 'binData' },
    },
  });
  const Records = collection('records', {
    _id: string(),
    name: string(),
    secret: encrypted(),
    profile: object({ label: string(), secret: encrypted() }),
    rows: array(object({ label: string(), secret: encrypted() })),
  });
  const db = createDatabase({
    uri: uri!,
    database: 'mica_aggregate_codecs',
    collections: { records: Records },
  });
  t.after(() => db.close());
  await db.connect();
  await db.records.insertOne({
    _id: 'one',
    name: 'record',
    secret: 'top',
    profile: { label: 'profile', secret: 'nested' },
    rows: [{ label: 'row', secret: 'array' }],
  });
  const base = db.records.aggregate();
  const full = {
    _id: 'one',
    name: 'record',
    secret: 'top',
    profile: { label: 'profile', secret: 'nested' },
    rows: [{ label: 'row', secret: 'array' }],
  };
  assert.deepEqual(await base.toArray(), [full]);
  assert.deepEqual(await base.project({}).toArray(), [full]);
  assert.deepEqual(await base.project({ name: 0 }).toArray(), [
    { _id: 'one', secret: 'top', profile: full.profile, rows: full.rows },
  ]);
  assert.equal(decodes, 9);
  decodes = 0;
  assert.deepEqual(
    await base.project({ secret: 0, 'profile.secret': 0, 'rows.secret': 0 }).toArray(),
    [{ _id: 'one', name: 'record', profile: { label: 'profile' }, rows: [{ label: 'row' }] }],
  );
  assert.equal(decodes, 0);
  assert.deepEqual(await base.project({ secret: 1, _id: 0 }).toArray(), [{ secret: 'top' }]);
  assert.deepEqual(
    await base.project({ 'profile.secret': 1, 'rows.secret': 1, _id: 0 }).toArray(),
    [{ profile: { secret: 'nested' }, rows: [{ secret: 'array' }] }],
  );
  assert.equal(decodes, 3);
  assert.deepEqual(
    await base.project({ profile: 1, rows: 1, _id: 0 }).project({ 'profile.secret': 0 }).toArray(),
    [{ profile: { label: 'profile' }, rows: [{ label: 'row', secret: 'array' }] }],
  );
  assert.equal(decodes, 4);
  assert.deepEqual(
    await base
      .project({ secret: 1, name: 1 })
      .group({ _id: '$name', total: { $sum: 1 } })
      .toArray(),
    [{ _id: 'record', total: 1 }],
  );
  assert.equal(decodes, 4);
  assert.deepEqual(await base.group({ _id: null, secret: { $sum: 1 } }).toArray(), [
    { _id: null, secret: 1 },
  ]);
  assert.equal(decodes, 4, 'group output names must not pick up original codecs');
  assert.deepEqual(
    await base.project({ 'rows.label': 1, _id: 0 }).match({ 'rows.label': 'row' }).toArray(),
    [{ rows: [{ label: 'row' }] }],
  );
  assert.deepEqual(await base.project({ _id: 1 }).toArray(), [{ _id: 'one' }]);
});

test('aggregation uses explicit sessions and refuses execution after close or abort', async (t) => {
  const Records = collection('records', { _id: string(), value: number() });
  const db = createDatabase({
    uri: uri!,
    database: 'mica_aggregate_sessions',
    collections: { records: Records },
  });
  t.after(() => db.close());
  assert.throws(() => db.records.aggregate(), /connect/);
  await db.connect();
  await db.records.insertOne({ _id: 'initial', value: 1 });
  const session = db.startSession();
  t.after(() => session.endSession());
  session.startTransaction();
  await db.records.insertOne({ _id: 'transaction', value: 2 }, { session });
  assert.deepEqual(await db.records.aggregate({ session }).count('total').toArray(), [
    { total: 2 },
  ]);
  assert.deepEqual(await db.records.aggregate().count('total').toArray(), [{ total: 1 }]);
  await session.abortTransaction();
  const controller = new AbortController();
  const pipeline = db.records.aggregate({ signal: controller.signal });
  const reason = new Error('stop aggregation');
  controller.abort(reason);
  await assert.rejects(pipeline.toArray(), (error) => error === reason);
  const reusable = db.records.aggregate();
  await db.close();
  await assert.rejects(reusable.toArray(), /connect/);
});

test('aggregation preserves ordered sort keys even for numeric field names', async (t) => {
  const Records = collection('records', { _id: string(), '10': number(), '2': number() });
  const db = createDatabase({
    uri: uri!,
    database: 'mica_aggregate_sort',
    collections: { records: Records },
  });
  t.after(() => db.close());
  await db.connect();
  await db.records.insertMany([
    { _id: 'a', '10': 2, '2': 1 },
    { _id: 'b', '10': 1, '2': 2 },
  ]);
  const pipeline = db.records
    .aggregate()
    .sort([
      ['10', 1],
      ['2', 1],
    ])
    .project({ _id: 1 });
  assert.deepEqual(await pipeline.toArray(), [{ _id: 'b' }, { _id: 'a' }]);
  assert.deepEqual(await pipeline.toArray(), [{ _id: 'b' }, { _id: 'a' }]);
});

test('aggregation casts ObjectId strings using the current stage schema, not the original collection', async (t) => {
  const Records = collection('records', {
    _id: objectId().auto(),
    owner: objectId(),
    label: string(),
    ids: array(objectId()),
    profile: object({ owner: objectId(), label: string() }),
    rows: array(object({ owner: objectId() })),
    links: map(objectId()),
  });
  const client = new MongoClient(uri!, { monitorCommands: true });
  let aggregates = 0;
  client.on('commandStarted', (event) => {
    if (event.commandName === 'aggregate') aggregates++;
  });
  const db = createDatabase({
    client,
    database: 'mica_aggregate_objectids',
    collections: { records: Records },
  });
  t.after(() => db.close());
  await db.connect();
  const owner = new ObjectId();
  const hex = owner.toHexString();
  const { insertedId } = await db.records.insertOne({
    owner,
    label: hex,
    ids: [owner],
    profile: { owner, label: hex },
    rows: [{ owner }],
    links: { primary: owner },
  });
  const base = db.records.aggregate();
  const result = await base.match({ _id: insertedId.toHexString().toUpperCase() }).toArray();
  assert.equal(result.length, 1);
  assert(result[0]!._id instanceof ObjectId);
  assert(result[0]!.owner instanceof ObjectId);
  assert.deepEqual(
    await base
      .match({
        $and: [{ owner: { $in: [hex] } }, { owner: { $not: { $ne: hex } } }],
        $or: [{ 'profile.owner': hex }, { 'rows.owner': hex }],
        ids: { $all: [hex], $elemMatch: { $eq: hex } },
        rows: { $elemMatch: { owner: hex } },
        'links.primary': hex,
        label: hex,
      })
      .count('total')
      .toArray(),
    [{ total: 1 }],
  );
  assert.deepEqual(
    await base
      .match({
        ids: [hex],
        profile: { owner: hex, label: hex },
        rows: [{ owner: hex }],
        links: { primary: hex },
      })
      .count('total')
      .toArray(),
    [{ total: 1 }],
  );
  assert.deepEqual(await base.project({ owner: 1, _id: 0 }).match({ owner: hex }).toArray(), [
    { owner },
  ]);
  assert.deepEqual(
    await base
      .group({ _id: '$owner', total: { $sum: 1 } })
      .match({ _id: hex })
      .toArray(),
    [{ _id: owner, total: 1 }],
  );
  // _id is now a string. Casting based on the original collection would break this match.
  assert.deepEqual(
    await base
      .group({ _id: '$label', total: { $sum: 1 } })
      .match({ _id: hex })
      .toArray(),
    [{ _id: hex, total: 1 }],
  );
  assert.deepEqual(
    await base
      .group({ _id: null, total: { $sum: 1 } })
      .group({ _id: '$total' })
      .match({ _id: 1 })
      .toArray(),
    [{ _id: 1 }],
  );
  const before = aggregates;
  assert.throws(() => base.match({ owner: 'invalid-id' }), MicaValidationError);
  assert.throws(
    () => base.project({ owner: 1 }).match({ owner: { $in: ['bad'] } }),
    MicaValidationError,
  );
  assert.equal(aggregates, before, 'invalid IDs never reach MongoDB');
});
