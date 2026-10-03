import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MongoClient, MongoOperationTimeoutError } from 'mongodb';
import {
  array,
  arrayFilter,
  object,
  customType,
  jsonSchema,
  map,
  timestamps,
  collection,
  createDatabase,
  number,
  string,
} from '../packages/db/src/index.js';

const uri = process.env.MICA_TEST_URI;
if (!uri) throw new Error('Use pnpm run test:integration for isolated MongoDB');

test(
  'execution budgets and cancellation reach MongoDB and lazy reads',
  { timeout: 30_000 },
  async (t) => {
    const appName = 'mica-execution-budgets';
    const client = new MongoClient(uri, { appName, monitorCommands: true });
    const admin = new MongoClient(uri);
    const Records = collection('execution', { _id: string(), count: number() });
    const db = createDatabase({
      client,
      database: 'mica_feature_gaps',
      collections: { records: Records },
    });
    t.after(async () => {
      await db.close();
      await admin.close();
    });
    await db.connect();
    await admin.connect();
    await db.records.insertMany([
      { _id: 'one', count: 1 },
      { _id: 'two', count: 2 },
    ]);
    const limits: number[] = [];
    client.on('commandStarted', (event) => {
      if (event.commandName === 'find') limits.push(event.command.maxTimeMS);
    });
    await db.records.find({}, { maxTimeMS: 12345 });
    assert(limits.includes(12345));

    async function delayNext(command: string) {
      await admin.db('admin').command({
        configureFailPoint: 'failCommand',
        mode: { times: 1 },
        data: { failCommands: [command], appName, blockConnection: true, blockTimeMS: 500 },
      });
    }
    try {
      await delayNext('find');
      await assert.rejects(db.records.find({}, { timeoutMS: 50 }), MongoOperationTimeoutError);
      await delayNext('aggregate');
      await assert.rejects(
        db.records.aggregate({ timeoutMS: 50 }).toArray(),
        MongoOperationTimeoutError,
      );
      for (const command of ['find', 'update', 'aggregate']) {
        await delayNext(command);
        const controller = new AbortController();
        const reason = new Error(`cancel in-flight ${command}`);
        const timer = setTimeout(() => controller.abort(reason), 50);
        try {
          const options = { signal: controller.signal };
          const operations = {
            find: () => db.records.find({}, options),
            aggregate: () => db.records.aggregate(options).toArray(),
            update: () => db.records.updateOne({ _id: 'one' }, { $inc: { count: 1 } }, options),
          };
          await assert.rejects(
            operations[command as keyof typeof operations](),
            (error) => error === reason,
          );
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      await admin.db('admin').command({ configureFailPoint: 'failCommand', mode: 'off' });
    }

    const controller = new AbortController();
    const reason = new Error('cancel queued work');
    const cursor = db.records.cursor({}, { signal: controller.signal, batchSize: 1 });
    await cursor.next();
    const chunks = db.records.chunks({}, { signal: controller.signal, size: 1 });
    await chunks.next();
    controller.abort(reason);
    await assert.rejects(cursor.next(), (error) => error === reason);
    assert(cursor.closed);
    await assert.rejects(chunks.next(), (error) => error === reason);
    const options = { signal: controller.signal };
    for (const operation of [
      () => db.records.insertOne({ _id: 'never', count: 1 }, options),
      () => db.records.insertMany([{ _id: 'never', count: 1 }], options),
      () => db.records.updateOne({}, { $inc: { count: 1 } }, options),
      () => db.records.updateMany({}, { $inc: { count: 1 } }, options),
      () => db.records.findOneAndUpdate({}, { $inc: { count: 1 } }, options),
      () => db.records.deleteOne({}, options),
      () => db.records.deleteMany({}, options),
      () => db.records.findOneAndDelete({}, options),
      () => db.records.bulkWrite([{ deleteMany: { filter: {} } }], options),
      () => db.records.distinct('count', {}, options),
      () => db.records.countDocuments({}, options),
      () => db.records.exists({}, options),
    ])
      await assert.rejects(operation(), (error) => error === reason);
    assert.equal(await db.records.countDocuments(), 2);
    assert.equal(await db.records.exists({ _id: 'never' }), false);
  },
);

test('embedded object pull supports partial predicates across all update entry points', async (t) => {
  const secret = customType({
    base: string,
    codec: {
      encode: (v: string) => `stored:${v}`,
      decode: (v: string) => v.slice(7),
      storedSchema: { bsonType: 'string' },
    },
  });
  const Records = collection('object_pull', {
    _id: string(),
    rows: array(object({ id: string(), score: number(), token: secret() })),
  });
  const db = createDatabase({
    uri,
    database: 'mica_feature_gaps',
    collections: { records: Records },
  });
  t.after(() => db.close());
  await db.connect();
  await db.records.insertOne({
    _id: 'one',
    rows: Array.from({ length: 5 }, (_, score) => ({
      id: `row-${score}`,
      score,
      token: 'private',
    })),
  });
  await db.records.updateOne({}, { $pull: { rows: { id: 'row-0' } } });
  await db.records.updateMany({}, { $pull: { rows: { score: { $gt: 3 } } } });
  const after = await db.records.findOneAndUpdate(
    {},
    { $pull: { rows: { $or: [{ id: 'row-1' }, { score: 2 }] } } },
    { returnDocument: 'after' },
  );
  assert.deepEqual(after?.rows, [{ id: 'row-3', score: 3, token: 'private' }]);
  await assert.rejects(
    db.records.updateOne({}, { $pull: { rows: { token: 'private' } } }),
    /codec/,
  );
  await db.records.bulkWrite([
    { updateOne: { filter: {}, update: { $pull: { rows: { id: 'row-3' } } } } },
  ]);
  assert.deepEqual((await db.records.findOne())?.rows, []);
});

test('increment upserts create counters and remain atomic across all update entry points', async (t) => {
  const Records = collection('increment_upserts', {
    _id: string(),
    count: number().integer().min(0).default(100),
    details: object({ hits: number(), label: string().default('new') }),
    counts: map(number()),
    ...timestamps(),
  });
  const db = createDatabase({
    uri,
    database: 'mica_feature_gaps',
    collections: { records: Records },
  });
  t.after(() => db.close());
  await db.connect();
  await db.client
    .db('mica_feature_gaps')
    .createCollection(Records.$name, { validator: jsonSchema(Records) });
  const update = { $inc: { count: 1, 'details.hits': 2, 'counts.session': 3 } };
  await Promise.all(
    Array.from({ length: 25 }, () =>
      db.records.updateOne({ _id: 'one' }, update, { upsert: true }),
    ),
  );
  const result = await db.records.findOne({ _id: 'one' });
  assert.equal(result?.count, 25);
  assert.deepEqual(result?.details, { hits: 50, label: 'new' });
  assert.deepEqual(result?.counts, { session: 75 });
  await db.records.updateMany({ _id: 'many' }, update, { upsert: true });
  const metadata = await db.records.findOneAndUpdate({ _id: 'returned', count: 4 }, update, {
    upsert: true,
    includeResultMetadata: true,
    returnDocument: 'after',
    projection: { count: 1 },
  });
  assert.equal(metadata.value?.count, 5);
  assert.equal(metadata.lastErrorObject?.updatedExisting, false);
  await db.records.bulkWrite([
    { updateOne: { filter: { _id: 'bulk-one' }, update, upsert: true } },
    { updateMany: { filter: { _id: 'bulk-many' }, update, upsert: true } },
  ]);
  assert.equal(await db.records.countDocuments(), 5);
  await assert.rejects(
    db.records.bulkWrite([
      { updateOne: { filter: { _id: 'never' }, update, upsert: true } },
      {
        updateOne: {
          filter: { _id: 'bad' },
          update: { ...update, $setOnInsert: { count: 0 } },
          upsert: true,
        },
      },
    ]),
    /Conflicting/,
  );
  assert.equal(await db.records.exists({ _id: 'never' }), false);
});

test('typed array-filter helpers compose with positional writes and runtime alias checks', async (t) => {
  const Records = collection('typed_array_filters', {
    _id: string(),
    rows: array(object({ name: string(), score: number() })),
  });
  const db = createDatabase({
    uri,
    database: 'mica_feature_gaps',
    collections: { records: Records },
  });
  t.after(() => db.close());
  await db.connect();
  await db.records.insertOne({
    _id: 'one',
    rows: [
      { name: 'yes', score: 1 },
      { name: 'no', score: 2 },
    ],
  });
  await db.records.updateOne(
    {},
    { $inc: { 'rows.$[row].score': 10 } },
    {
      arrayFilters: [
        arrayFilter('row', Records.rows, { $or: [{ name: 'yes' }, { score: { $gt: 10 } }] }),
      ],
    },
  );
  assert.deepEqual(
    (await db.records.findOne())?.rows.map((row) => row.score),
    [11, 2],
  );
  await assert.rejects(
    db.records.updateOne(
      {},
      { $inc: { 'rows.$[row].score': 10 } },
      {
        arrayFilters: [arrayFilter('different', Records.rows, { name: 'yes' })],
      },
    ),
    /identifier/,
  );
});
