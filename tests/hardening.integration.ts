import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  array,
  collection,
  createDatabase,
  customType,
  jsonSchema,
  map,
  number,
  object,
  string,
  timestamps,
} from '../src/index.js';
const uri = process.env.MICA_TEST_URI;
if (!uri) throw new Error('Use npm run test:integration for an isolated MongoDB container');

test('numeric equality and map entry upserts work across every write entry point', async (t) => {
  const Records = collection('upserts', {
    _id: string(),
    count: number(),
    profile: object({ score: number() }),
    counts: map(number()),
    ...timestamps(),
  });
  const db = createDatabase({ uri, database: 'mica_hardening', collections: { records: Records } });
  t.after(() => db.close());
  await db.connect();
  await db.client
    .db('mica_hardening')
    .createCollection(Records.$name, { validator: jsonSchema(Records) });
  const filter = (id: string) => ({
    _id: id,
    count: { $eq: 3 },
    profile: { score: 1.5 },
    counts: { old: 2 },
  });
  const update = { $set: { 'counts.next': 7 } };
  await db.records.updateOne(filter('one'), update, { upsert: true });
  await db.records.updateMany(filter('many'), update, { upsert: true });
  const metadata = await db.records.findOneAndUpdate(filter('returned'), update, {
    upsert: true,
    includeResultMetadata: true,
    returnDocument: 'after',
    projection: { 'counts.next': 1, 'profile.score': 1, _id: 0 },
  });
  assert.equal(metadata.lastErrorObject?.updatedExisting, false);
  assert.deepEqual(metadata.value, { counts: { next: 7 }, profile: { score: 1.5 } });
  await db.records.bulkWrite([
    { updateOne: { filter: filter('bulk-one'), update, upsert: true } },
    { updateMany: { filter: filter('bulk-many'), update, upsert: true } },
  ]);
  const rows = await db.records.find();
  assert.equal(rows.length, 5);
  for (const row of rows) {
    assert.equal(row.count, 3);
    assert.equal(row.profile.score, 1.5);
    assert.deepEqual(row.counts, { old: 2, next: 7 });
  }
  await db.records.updateOne(
    { _id: 'one' },
    {
      $set: { 'counts.next': 8 },
      $setOnInsert: { count: 3, profile: { score: 1.5 } },
    },
    { upsert: true },
  );
  assert.deepEqual((await db.records.findOne({ _id: 'one' }))?.counts, { old: 2, next: 8 });
});

test('projected codecs, positional writes and immutable descendants compose', async (t) => {
  let decodes = 0;
  const secret = customType({
    base: string,
    codec: {
      encode: (v: string) => `stored:${v}`,
      decode: (v: string) => {
        decodes++;
        return v.slice(7);
      },
      storedSchema: { bsonType: 'string' },
    },
  });
  const Records = collection('interactions', {
    _id: string(),
    rows: array(object({ key: string().immutable(), secret: secret(), score: number() })),
  });
  const db = createDatabase({ uri, database: 'mica_hardening', collections: { records: Records } });
  t.after(() => db.close());
  await db.connect();
  await db.records.insertOne({ _id: 'one', rows: [{ key: 'first', secret: 'old', score: 0 }] });
  const result = await db.records.findOneAndUpdate(
    { _id: 'one' },
    {
      $set: { 'rows.$[row].secret': 'new' },
      $inc: { 'rows.$[row].score': 1 },
    },
    {
      arrayFilters: [{ 'row.key': 'first' }],
      returnDocument: 'after',
      projection: { 'rows.secret': 0 },
    },
  );
  assert.deepEqual(result?.rows, [{ key: 'first', score: 1 }]);
  assert.equal(decodes, 0);
  for await (const batch of db.records.chunks({}, { size: 1, projection: { 'rows.secret': 0 } }))
    assert.deepEqual(batch[0]?.rows, [{ key: 'first', score: 1 }]);
  assert.equal(decodes, 0);
  assert.deepEqual(await db.records.findOne({}, { projection: { 'rows.secret': 1, _id: 0 } }), {
    rows: [{ secret: 'new' }],
  });
  assert.equal(decodes, 1);
  const raw = db.client.db('mica_hardening').collection(Records.$name);
  assert.equal((await raw.findOne())?.rows[0].secret, 'stored:new');
  await assert.rejects(
    db.records.bulkWrite([
      { updateOne: { filter: {}, update: { $inc: { 'rows.0.score': 10 } } } },
      // @ts-expect-error Deliberately exercise runtime validation for JavaScript callers.
      { updateOne: { filter: {}, update: { $set: { 'rows.0.key': 'changed' } } } },
    ]),
    /immutable/,
  );
  assert.equal((await db.records.findOne())?.rows[0]?.score, 1);
});

test(
  'concurrent increments and a real transaction write conflict preserve all committed changes',
  { timeout: 30_000 },
  async (t) => {
    const Counters = collection('counters', { _id: string(), count: number() });
    const db = createDatabase({
      uri,
      database: 'mica_hardening',
      collections: { counters: Counters },
    });
    t.after(() => db.close());
    await db.connect();
    await db.counters.insertOne({ _id: 'one', count: 0 });
    await Promise.all(
      Array.from({ length: 128 }, () =>
        db.counters.updateOne({ _id: 'one' }, { $inc: { count: 1 } }),
      ),
    );
    assert.equal((await db.counters.findOne())?.count, 128);

    let readers = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempts = [0, 0];
    await Promise.all(
      [0, 1].map((worker) =>
        db.withTransaction(async (session) => {
          attempts[worker]!++;
          const before = await db.counters.findOne({ _id: 'one' }, { session });
          assert(before);
          if (attempts[worker] === 1) {
            if (++readers === 2) release();
            await bothRead;
          }
          await db.counters.updateOne(
            { _id: 'one' },
            { $set: { count: before.count + 1 } },
            { session },
          );
        }),
      ),
    );
    assert(attempts[0]! + attempts[1]! >= 3, 'a server write conflict must retry one callback');
    assert.equal((await db.counters.findOne())?.count, 130);
  },
);
