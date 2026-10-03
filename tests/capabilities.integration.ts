import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  array,
  collection,
  createDatabase,
  customType,
  map,
  jsonSchema,
  date,
  number,
  object,
  objectId,
  string,
  timestamps,
} from '../packages/db/src/index.js';

const uri = process.env.MICA_TEST_URI;
if (!uri) throw new Error('Use pnpm run test:integration for an isolated MongoDB container');

test('scalar array operators work across update entry points', async (t) => {
  const Records = collection('arrays', {
    _id: objectId().auto(),
    labels: array(string()),
    counts: array(number()),
    ...timestamps(),
  });
  const db = createDatabase({
    uri,
    database: 'mica_capabilities',
    collections: { records: Records },
  });
  t.after(() => db.close());
  await db.connect();
  const { insertedId } = await db.records.insertOne({
    labels: ['old', 'keep'],
    counts: [1, 2, 3, 4],
  });
  const filter = { _id: insertedId };
  await db.records.updateOne(filter, { $addToSet: { labels: { $each: ['keep', 'new', 'new'] } } });
  await db.records.updateMany(filter, { $pull: { counts: { $gte: 3 } } });
  const value = await db.records.findOneAndUpdate(
    filter,
    { $pull: { labels: /^old/ } },
    { returnDocument: 'after' },
  );
  assert.deepEqual(value?.labels, ['keep', 'new']);
  assert.deepEqual(value?.counts, [1, 2]);
  await db.records.bulkWrite([
    { updateOne: { filter, update: { $addToSet: { counts: 2 } } } },
    { updateMany: { filter, update: { $pull: { counts: { $in: [1] } } } } },
  ]);
  assert.deepEqual((await db.records.findOne(filter))?.counts, [2]);
});

test('min/max compare numbers and dates atomically', async (t) => {
  const Records = collection('bounds', {
    _id: objectId().auto(),
    low: number().optional(),
    high: date().optional(),
  });
  const db = createDatabase({
    uri,
    database: 'mica_capabilities',
    collections: { records: Records },
  });
  t.after(() => db.close());
  await db.connect();
  const { insertedId } = await db.records.insertOne({});
  const filter = { _id: insertedId };
  await Promise.all(
    [3, 1, 5, 2].map((n) =>
      db.records.updateOne(filter, { $min: { low: n }, $max: { high: new Date(n * 1000) } }),
    ),
  );
  const value = await db.records.findOne(filter);
  assert.equal(value?.low, 1);
  assert.equal(value?.high?.getTime(), 5000);
});

test('array, regex, type, negation and element predicates retain MongoDB semantics', async (t) => {
  const Records = collection('filters', {
    _id: objectId().auto(),
    name: string(),
    tags: array(string()),
    values: array(number()),
    rows: array(object({ score: number(), state: string() })),
  });
  const db = createDatabase({
    uri,
    database: 'mica_capabilities',
    collections: { records: Records },
  });
  t.after(() => db.close());
  await db.connect();
  await db.records.insertMany([
    {
      name: 'Alpha',
      tags: ['a', 'b'],
      values: [1, 3],
      rows: [
        { score: 1, state: 'yes' },
        { score: 5, state: 'no' },
      ],
    },
    { name: 'Beta', tags: [], values: [2], rows: [{ score: 5, state: 'yes' }] },
  ]);
  assert.deepEqual(
    await db.records.distinct('name', {
      tags: { $all: ['a', 'b'], $size: 2 },
      name: { $regex: '^alpha$', $options: 'i' },
    }),
    ['Alpha'],
  );
  assert.deepEqual(await db.records.distinct('name', { tags: { $size: 0 } }), ['Beta']);
  assert.deepEqual(
    await db.records.distinct('name', {
      rows: { $elemMatch: { score: { $gte: 4 }, state: 'yes' } },
    }),
    ['Beta'],
  );
  assert.deepEqual(
    await db.records.distinct('name', { values: { $elemMatch: { $gt: 1, $lt: 3 } } }),
    ['Beta'],
  );
  assert.deepEqual(await db.records.distinct('name', { name: { $not: /^A/, $type: 'string' } }), [
    'Beta',
  ]);
  await assert.rejects(db.records.find({ name: { $options: 'i' } }), /requires.*regex/);
});

test('push modifiers and per-update timestamps preserve native behavior', async (t) => {
  const Records = collection('push_modifiers', {
    _id: objectId().auto(),
    values: array(number()),
    rows: array(object({ rank: number() })),
    ...timestamps(),
  });
  const db = createDatabase({
    uri,
    database: 'mica_capabilities',
    collections: { records: Records },
  });
  t.after(() => db.close());
  await db.connect();
  const old = new Date('2020-01-01');
  const { insertedId } = await db.records.insertOne({
    values: [3, 1],
    rows: [{ rank: 2 }],
    updatedAt: old,
  });
  const filter = { _id: insertedId };
  await db.records.updateOne(
    filter,
    { $push: { values: { $each: [2], $sort: 1, $slice: 2 } } },
    { timestamps: false },
  );
  await db.records.updateMany(
    filter,
    { $push: { rows: { $each: [{ rank: 1 }], $sort: { rank: 1 }, $slice: 1 } } },
    { timestamps: false },
  );
  const value = await db.records.findOneAndUpdate(
    filter,
    { $push: { values: { $each: [9], $position: 0 } } },
    { timestamps: false, returnDocument: 'after' },
  );
  assert.deepEqual(value?.values, [9, 1, 2]);
  assert.deepEqual(value?.rows, [{ rank: 1 }]);
  assert.deepEqual(value?.updatedAt, old);
  await db.records.bulkWrite([
    { updateOne: { filter, update: { $pull: { values: 9 } }, timestamps: false } },
  ]);
  assert.deepEqual((await db.records.findOne(filter))?.updatedAt, old);
  await db.records.updateOne(filter, { $push: { values: 10 } });
  assert((await db.records.findOne(filter))!.updatedAt > old);
});

test('collation, hints, and read preferences reach applicable read and write operations', async (t) => {
  const Records = collection('query_options', {
    _id: objectId().auto(),
    name: string(),
    count: number().default(0),
  });
  const db = createDatabase({
    uri,
    database: 'mica_capabilities',
    collections: { records: Records },
  });
  t.after(() => db.close());
  await db.connect();
  const collation = { locale: 'en', strength: 2 };
  await db.client
    .db('mica_capabilities')
    .collection('query_options')
    .createIndex({ name: 1 }, { name: 'names', collation });
  await db.records.insertMany([{ name: 'Alpha' }, { name: 'alpha' }]);
  const options = { collation, hint: 'names', readPreference: 'primary' as const };
  assert.equal((await db.records.find({ name: 'ALPHA' }, options)).length, 2);
  assert.equal(await db.records.exists({ name: 'ALPHA' }, options), true);
  assert.equal(await db.records.countDocuments({ name: 'ALPHA' }, options), 2);
  assert.equal((await db.records.distinct('name', {}, options)).length, 1);
  const chunks = [];
  for await (const batch of db.records.chunks({ name: 'ALPHA' }, { ...options, size: 1 }))
    chunks.push(...batch);
  assert.equal(chunks.length, 2);
  assert.equal(
    (
      await db.records.updateMany(
        { name: 'ALPHA' },
        { $inc: { count: 1 } },
        { collation, hint: 'names' },
      )
    ).modifiedCount,
    2,
  );
  assert.equal(
    (
      await db.records.findOneAndUpdate(
        { name: 'ALPHA' },
        { $inc: { count: 1 } },
        { collation, hint: 'names', returnDocument: 'after' },
      )
    )?.count,
    2,
  );
  await db.records.bulkWrite([
    {
      updateMany: {
        filter: { name: 'ALPHA' },
        update: { $inc: { count: 1 } },
        collation,
        hint: 'names',
      },
    },
  ]);
  assert(await db.records.findOneAndDelete({ name: 'ALPHA' }, { collation, hint: 'names' }));
  assert.equal(
    (await db.records.deleteMany({ name: 'ALPHA' }, { collation, hint: 'names' })).deletedCount,
    1,
  );
  await assert.rejects(db.records.find({}, { readPreference: 'invalid' as never }));
  await assert.rejects(
    db.records.updateOne({}, { $inc: { count: 1 } }, { readPreference: 'secondary' } as never),
    /unsupported option/,
  );
});

test('string IDs retain their types through inserts, filters, and projected chunks', async (t) => {
  const Records = collection('string_ids', { _id: string(), name: string() });
  const db = createDatabase({
    uri,
    database: 'mica_capabilities',
    collections: { records: Records },
  });
  t.after(() => db.close());
  await db.connect();
  const ids = ['', 'z', 'é', '😀', '\uE000'];
  const inserted = await db.records.insertMany(ids.map((_id) => ({ _id, name: `name:${_id}` })));
  assert.equal(inserted.insertedIds[0], '');
  const seen: string[] = [];
  for await (const batch of db.records.chunks({}, { size: 1 }))
    seen.push(...batch.map(({ _id }) => _id));
  assert.deepEqual(
    seen,
    [...ids].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
  );
  const resumed: string[] = [];
  for await (const batch of db.records.chunks(
    {},
    { size: 2, afterId: '', projection: { name: 1, _id: 0 } },
  ))
    resumed.push(...batch.map(({ name }) => name));
  assert.deepEqual(
    resumed,
    seen.slice(1).map((id) => `name:${id}`),
  );
  assert.throws(
    () => db.records.chunks({}, { size: 1, collation: { locale: 'en', strength: 2 } }),
    /simple collation/,
  );
  assert.throws(() => db.records.chunks({}, { size: 1, afterId: 1 as never }), /string/);
  await assert.rejects(db.records.insertOne({ _id: 1, name: 'wrong' } as never), /string/);
});

test('sessions propagate through reads, cursors, chunks, and writes; transactions commit or roll back', async (t) => {
  const Records = collection('transactions', { _id: string(), count: number().default(0) });
  const db = createDatabase({
    uri,
    database: 'mica_capabilities',
    collections: { records: Records },
  });
  t.after(() => db.close());
  assert.throws(() => db.startSession(), /connect/);
  await db.connect();
  await db.client.db('mica_capabilities').createCollection('transactions');
  const result = await db.withTransaction(async (session) => {
    await db.records.insertOne({ _id: 'one' }, { session });
    await db.records.insertMany([{ _id: 'two' }], { session });
    assert.equal(await db.records.exists({ _id: 'one' }, { session }), true);
    assert.equal(await db.records.exists({ _id: 'one' }), false);
    assert.equal(await db.records.countDocuments({}, { session }), 2);
    assert.equal((await db.records.distinct('_id', {}, { session })).length, 2);
    assert.equal((await db.records.cursor({}, { session }).toArray()).length, 2);
    let count = 0;
    for await (const batch of db.records.chunks({}, { size: 1, session })) count += batch.length;
    assert.equal(count, 2);
    await db.records.updateOne({ _id: 'one' }, { $inc: { count: 1 } }, { session });
    await db.records.updateMany({}, { $inc: { count: 1 } }, { session });
    await db.records.bulkWrite([{ updateMany: { filter: {}, update: { $inc: { count: 1 } } } }], {
      session,
    });
    assert.equal(
      (
        await db.records.findOneAndUpdate(
          { _id: 'one' },
          { $inc: { count: 1 } },
          { session, returnDocument: 'after' },
        )
      )?.count,
      4,
    );
    assert(await db.records.findOneAndDelete({ _id: 'two' }, { session }));
    return 'committed';
  });
  assert.equal(result, 'committed');
  assert.equal((await db.records.findOne({ _id: 'one' }))?.count, 4);
  await assert.rejects(
    db.withTransaction(async (session) => {
      await db.records.deleteOne({ _id: 'one' }, { session });
      await db.records.insertOne({ _id: 'rollback' }, { session });
      throw new Error('application failure');
    }),
    /application failure/,
  );
  assert.equal(await db.records.exists({ _id: 'one' }), true);
  assert.equal(await db.records.exists({ _id: 'rollback' }), false);
  const ended = db.startSession();
  await ended.endSession();
  await assert.rejects(db.records.find({}, { session: ended }), /active ClientSession/);
});

test('upserts validate complete insertion and preserve immutable fields on subsequent matches', async (t) => {
  const Records = collection('upserts', {
    _id: string(),
    name: string(),
    fixed: string().immutable(),
    profile: object({ count: number().default(5), label: string() }),
    ...timestamps(),
  });
  const db = createDatabase({
    uri,
    database: 'mica_capabilities',
    collections: { records: Records },
  });
  t.after(() => db.close());
  await db.connect();
  const filter = { _id: 'one' };
  const initial = await db.records.findOneAndUpdate(
    filter,
    { $set: { name: 'First', 'profile.label': 'label' }, $setOnInsert: { fixed: 'original' } },
    {
      upsert: true,
      returnDocument: 'after',
      includeResultMetadata: true,
      projection: { name: 1, fixed: 1, profile: 1, _id: 0 },
    },
  );
  assert.equal(initial.lastErrorObject?.updatedExisting, false);
  assert.equal(initial.lastErrorObject?.upserted, 'one');
  assert.deepEqual(initial.value, {
    name: 'First',
    fixed: 'original',
    profile: { count: 5, label: 'label' },
  });
  const original = await db.records.findOne(filter);
  const matched = await db.records.findOneAndUpdate(
    filter,
    {
      $set: { name: 'Changed', 'profile.label': 'next' },
      $setOnInsert: { fixed: 'new insertion value' },
    },
    { upsert: true, includeResultMetadata: true, returnDocument: 'after', timestamps: false },
  );
  assert.equal(matched.lastErrorObject?.updatedExisting, true);
  assert.equal(matched.value?.fixed, 'original');
  assert.deepEqual(matched.value?.updatedAt, original?.updatedAt);
  assert.deepEqual(matched.value?.createdAt, original?.createdAt);
  const insertOnly = {
    $setOnInsert: { name: 'Second', fixed: 'fixed', profile: { label: 'label' } },
  };
  const second = await db.records.updateMany({ _id: 'two' }, insertOnly, { upsert: true });
  assert.equal(second.upsertedId, 'two');
  await db.records.bulkWrite([
    { updateOne: { filter: { _id: 'three' }, update: insertOnly, upsert: true } },
  ]);
  assert.equal(await db.records.countDocuments(), 3);
  await assert.rejects(
    db.records.updateOne({ _id: 'missing' }, { $setOnInsert: { fixed: 'x' } }, { upsert: true }),
    /required field/,
  );
  assert.equal(await db.records.exists({ _id: 'missing' }), false);
});

test('nested projections infer and decode only selected leaves, including arrays and codecs', async (t) => {
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
  const Records = collection('nested_projections', {
    _id: string(),
    profile: object({ name: string(), secret: secret() }).optional(),
    rows: array(object({ name: string(), secret: secret() })),
    hidden: object({ name: string(), secret: secret() }),
  });
  const db = createDatabase({
    uri,
    database: 'mica_capabilities',
    collections: { records: Records },
  });
  t.after(() => db.close());
  await db.connect();
  await db.records.insertOne({
    _id: 'one',
    profile: { name: 'P', secret: 'p' },
    rows: [{ name: 'R', secret: 'r' }],
    hidden: { name: 'H', secret: 'h' },
  });
  assert.deepEqual(
    await db.records.findOne({}, { projection: { 'profile.name': 1, 'rows.name': 1, _id: 0 } }),
    { profile: { name: 'P' }, rows: [{ name: 'R' }] },
  );
  assert.equal(decodes, 0);
  assert.deepEqual(
    await db.records.findOne({}, { projection: { 'profile.secret': 1, 'rows.secret': 1, _id: 0 } }),
    { profile: { secret: 'p' }, rows: [{ secret: 'r' }] },
  );
  assert.equal(decodes, 2);
  assert.deepEqual(
    await db.records.findOne({}, { projection: { 'hidden.name': 0, 'profile.name': 0, _id: 0 } }),
    { profile: { secret: 'p' }, rows: [{ name: 'R', secret: 'r' }], hidden: { secret: 'h' } },
  );
  assert.equal(decodes, 5);
  for await (const batch of db.records.chunks(
    {},
    { size: 1, projection: { 'hidden.name': 1, _id: 0 } },
  ))
    assert.deepEqual(batch, [{ hidden: { name: 'H' } }]);
  await assert.rejects(
    db.records.find({}, { projection: { profile: 1, 'profile.name': 1 } }),
    /conflicting projection/,
  );
});

test('numeric, matched, all, and filtered positional writes preserve field codecs and immutability', async (t) => {
  const secret = customType({
    base: string,
    codec: {
      encode: (v: string) => `stored:${v}`,
      decode: (v: string) => v.slice(7),
      storedSchema: { bsonType: 'string' },
    },
  });
  const Records = collection('positional', {
    _id: string(),
    rows: array(
      object({
        key: string().immutable(),
        count: number(),
        secret: secret(),
        rewards: array(object({ name: string(), count: number() })),
      }),
    ),
  });
  const db = createDatabase({
    uri,
    database: 'mica_capabilities',
    collections: { records: Records },
  });
  t.after(() => db.close());
  await db.connect();
  await db.records.insertOne({
    _id: 'one',
    rows: [
      { key: 'a', count: 0, secret: 'a', rewards: [{ name: 'first', count: 0 }] },
      { key: 'b', count: 0, secret: 'b', rewards: [] },
    ],
  });
  await db.records.updateOne({ _id: 'one' }, { $set: { 'rows.0.secret': 'changed' } });
  await db.records.updateMany({}, { $inc: { 'rows.$[].count': 1 } });
  await db.records.findOneAndUpdate({ 'rows.key': 'b' }, { $inc: { 'rows.$.count': 2 } });
  await db.records.updateOne(
    {},
    { $inc: { 'rows.$[row].rewards.$[reward].count': 5 } },
    { arrayFilters: [{ 'row.key': 'a' }, { 'reward.name': 'first' }] },
  );
  await db.records.bulkWrite([
    {
      updateOne: {
        filter: {},
        update: { $set: { 'rows.$[row].secret': 'filtered' } },
        arrayFilters: [{ 'row.key': 'b' }],
      },
    },
  ]);
  const result = await db.records.findOne();
  assert.deepEqual(
    result?.rows.map(({ count, secret: token }) => ({ count, token })),
    [
      { count: 1, token: 'changed' },
      { count: 3, token: 'filtered' },
    ],
  );
  assert.equal(result?.rows[0]?.rewards[0]?.count, 5);
  const raw = await db.client
    .db('mica_capabilities')
    .collection('positional')
    .findOne({ _id: 'one' } as never);
  assert.equal(raw?.rows[1].secret, 'stored:filtered');
  await assert.rejects(
    db.records.updateOne({}, { $inc: { 'rows.$[row].count': 1 } }),
    /Missing arrayFilters/,
  );
});

test('dynamic map entries support typed writes, projections, codecs, and server validation', async (t) => {
  const token = customType({
    base: string,
    codec: {
      encode: (v: string) => `stored:${v}`,
      decode: (v: string) => v.slice(7),
      storedSchema: { bsonType: 'string' },
    },
  });
  const Records = collection('maps', {
    _id: string(),
    counts: map(number().integer()),
    sessions: map(object({ name: string(), visits: number().default(0) })),
    tokens: map(token()),
  });
  const db = createDatabase({
    uri,
    database: 'mica_capabilities',
    collections: { records: Records },
  });
  t.after(() => db.close());
  await db.connect();
  const raw = await db.client
    .db('mica_capabilities')
    .createCollection('maps', { validator: jsonSchema(Records) });
  await db.records.insertOne({ _id: 'one', counts: {}, sessions: {}, tokens: {} });
  await db.records.updateOne(
    {},
    {
      $inc: { 'counts.browser-1': 2 },
      $set: { 'sessions.browser-1': { name: 'Browser' }, 'tokens.browser-1': 'secret' },
    },
  );
  assert.equal(await db.records.exists({ 'counts.browser-1': { $gte: 2 } }), true);
  assert.deepEqual(await db.records.distinct('counts.browser-1'), [2]);
  assert.deepEqual(
    await db.records.findOne({}, { projection: { 'sessions.browser-1': 1, _id: 0 } }),
    { sessions: { 'browser-1': { name: 'Browser', visits: 0 } } },
  );
  assert.deepEqual(
    await db.records.findOne({}, { projection: { 'tokens.browser-1': 1, _id: 0 } }),
    { tokens: { 'browser-1': 'secret' } },
  );
  assert.deepEqual((await db.records.findOne())?.tokens, { 'browser-1': 'secret' });
  assert.equal((await raw.findOne())?.tokens['browser-1'], 'stored:secret');
  await db.records.updateOne({}, { $unset: { 'counts.browser-1': 1, 'tokens.browser-1': 1 } });
  assert.deepEqual(await db.records.distinct('counts.browser-1'), []);
  await assert.rejects(
    raw.insertOne({
      _id: 'invalid',
      counts: { bad: 'not a number' },
      sessions: {},
      tokens: {},
    } as never),
    (error: any) => error.code === 121,
  );
  await assert.rejects(
    raw.insertOne({
      _id: 'invalid-key',
      counts: { 'bad.key': 1 },
      sessions: {},
      tokens: {},
    } as never),
    (error: any) => error.code === 121,
  );
});
