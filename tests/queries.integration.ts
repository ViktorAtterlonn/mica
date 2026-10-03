import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MongoBulkWriteError, MongoClient, ObjectId, type Document } from 'mongodb';
import {
  array,
  collection,
  createDatabase,
  customType,
  jsonSchema,
  number,
  object,
  objectId,
  string,
  timestamps,
} from '../packages/db/src/index.js';

const uri = process.env.MICA_TEST_URI;
if (!uri) throw new Error('Use pnpm run test:integration for an isolated MongoDB container');

test('query API: cursor reads, existence, batch writes and returned documents', async (t) => {
  let decodes = 0;
  const secret = customType({
    base: string,
    codec: {
      encode: (value: string) => `stored:${value}`,
      decode: (value: string) => {
        decodes++;
        if (value === 'broken') throw new Error('invalid stored token');
        return value.slice(7);
      },
      storedSchema: { bsonType: 'string' },
    },
  });
  const Records = collection('records', {
    _id: objectId().auto(),
    name: string(),
    group: string().default('default'),
    rank: number(),
    token: secret(),
    fixed: string().immutable().default('original'),
    profile: object({
      label: string(),
      token: secret(),
      fixed: string().immutable().default('original'),
    }),
    entries: array(
      object({ label: string(), token: secret(), fixed: string().immutable().default('new') }),
    ).default(() => []),
    ...timestamps(),
  });
  const client = new MongoClient(uri, { monitorCommands: true });
  const commands: { name: string; command: Document }[] = [];
  client.on('commandStarted', (e) => commands.push({ name: e.commandName, command: e.command }));
  const db = createDatabase({
    client,
    database: 'mica_queries',
    collections: { records: Records },
  });
  t.after(() => db.close());
  await db.connect();
  const raw = await client
    .db('mica_queries')
    .createCollection(Records.$name, { validator: jsonSchema(Records) });
  await raw.createIndex({ name: 1 }, { unique: true });
  const input = (name: string, rank: number, group = 'read') => ({
    name,
    rank,
    group,
    token: `token-${name}`,
    profile: { label: name, token: `nested-${name}` },
  });
  const writeCount = () =>
    commands.filter((e) => ['insert', 'update', 'delete', 'findAndModify'].includes(e.name)).length;

  await t.test(
    'insertMany supplies defaults, IDs and timestamps without mutating input',
    async () => {
      const documents = Object.freeze([
        Object.freeze(input('a', 1)),
        Object.freeze(input('b', 2)),
        Object.freeze(input('c', 3)),
        Object.freeze(input('d', 4)),
      ]);
      const result = await db.records.insertMany(documents);
      assert.equal(result.insertedCount, 4);
      assert(Object.values(result.insertedIds).every((id) => id instanceof ObjectId));
      assert.equal(
        new Set(Object.values(result.insertedIds).map((id) => id.toHexString())).size,
        4,
      );
      assert(!('_id' in documents[0]!));
      assert(!('fixed' in documents[0]!.profile));
      const stored = await raw.find({ group: 'read' }).sort({ rank: 1 }).toArray();
      assert.equal(stored[0]!.token, 'stored:token-a');
      assert.equal(stored[0]!.profile.token, 'stored:nested-a');
      assert.equal(stored[0]!.fixed, 'original');
      assert.deepEqual(stored[0]!.entries, []);
      assert(stored[0]!.createdAt instanceof Date);
      assert.deepEqual(stored[0]!.createdAt, stored[3]!.createdAt);
    },
  );

  await t.test(
    'cursor is lazy, snapshots input, paginates, decodes selected fields and closes',
    async () => {
      const before = commands.length;
      const filter = { group: 'read' };
      const sort: { rank: 1 | -1 } = { rank: -1 };
      const cursor = db.records.cursor(filter, {
        sort,
        skip: 1,
        limit: 2,
        batchSize: 1,
        projection: { _id: 0, token: 0, 'profile.token': 0 },
      });
      assert.equal(commands.length, before);
      filter.group = 'changed-after-creation';
      sort.rank = 1;
      decodes = 0;
      const result = await cursor.toArray();
      assert.deepEqual(
        result.map((x) => x.name),
        ['c', 'b'],
      );
      assert(!('_id' in result[0]!));
      assert(!('token' in result[0]!));
      assert(!('token' in result[0]!.profile));
      assert.equal(decodes, 0);
      assert(cursor.closed);
      assert.equal(await cursor.next(), null);
      assert.deepEqual(await cursor.toArray(), []);
      assert(commands.slice(before).some((e) => e.name === 'getMore'));
      const command = commands.slice(before).find((e) => e.name === 'find')!.command;
      assert.deepEqual(command.projection, { _id: 0, token: 0, 'profile.token': 0 });
      assert.equal(command.limit, 2);
      assert.equal(command.skip, 1);

      const selected = db.records
        .cursor({ group: 'read' }, { projection: { name: 1, token: 1, _id: 1 } })
        .sort([['rank', 1]])
        .skip(1)
        .limit(2)
        .batchSize(1);
      const first = await selected.next();
      assert(first?._id instanceof ObjectId);
      assert.equal(first?.token, 'token-b');
      assert.throws(() => selected.limit(1), /started/);
      assert.deepEqual(
        (await selected.toArray()).map((x) => x.token),
        ['token-c'],
      );
      assert.equal(decodes, 2);
      const none = db.records.cursor({ name: 'absent' });
      assert.equal(await none.next(), null);
      assert(none.closed);
    },
  );

  await t.test('iterator early exit and decode errors close server cursors', async () => {
    const before = commands.length;
    const cursor = db.records.cursor({ group: 'read' }, { batchSize: 1 }).sort({ rank: 1 });
    for await (const value of cursor) {
      assert.equal(value.name, 'a');
      break;
    }
    assert(cursor.closed);
    assert(commands.slice(before).some((e) => e.name === 'killCursors'));
    const closed = db.records.cursor({ group: 'read' });
    const beforeClose = commands.length;
    await closed.close();
    await closed.close();
    assert.equal(await closed.next(), null);
    assert.equal(commands.length, beforeClose);
    assert.throws(() => closed.sort({ name: 1 }), /closed/);

    await db.records.insertMany([input('broken-a', 1, 'broken'), input('broken-b', 2, 'broken')]);
    await raw.updateOne({ name: 'broken-a' }, { $set: { token: 'broken' } });
    const beforeError = commands.length;
    const broken = db.records.cursor(
      { group: 'broken' },
      { projection: { token: 1 }, sort: { rank: 1 }, batchSize: 1 },
    );
    await assert.rejects(broken.next(), /invalid stored token/);
    assert(broken.closed);
    assert(commands.slice(beforeError).some((e) => e.name === 'killCursors'));
    const iteratorCursor = db.records.cursor({ group: 'read' });
    const iterator = iteratorCursor[Symbol.asyncIterator]();
    await iterator.next();
    await assert.rejects(iteratorCursor.next(), /active consumer/);
    await iterator.return?.();
    assert(iteratorCursor.closed);
  });

  await t.test('exists and count do not decode tokens, including corrupt stored data', async () => {
    decodes = 0;
    assert.equal(await db.records.exists({ group: 'broken' }), true);
    assert.equal(await db.records.exists({ name: 'missing' }), false);
    assert.equal(await db.records.exists({ token: { $exists: true } }), true);
    const last = commands.filter((e) => e.name === 'find').at(-1)!.command;
    assert.deepEqual(last.projection, { _id: 1 });
    assert.equal(last.limit, 1);
    assert.equal(last.singleBatch, true);
    assert.equal(await db.records.countDocuments({ group: 'read' }), 4);
    assert.equal(await db.records.countDocuments({ group: 'read' }, { skip: 1, limit: 2 }), 2);
    assert.equal(await db.records.countDocuments({ group: 'read' }, { limit: 0 }), 4);
    assert.equal(decodes, 0);
    assert.equal(
      (await db.records.findOne({ group: 'read' }, { sort: { rank: -1 }, projection: { name: 1 } }))
        ?.name,
      'd',
    );
  });

  await t.test(
    'updateMany encodes nested updates and appends with timestamps for every match',
    async () => {
      const before = await raw.findOne({ name: 'a' });
      const result = await db.records.updateMany(
        { group: 'read' },
        {
          $set: { token: 'rotated', 'profile.label': 'updated' },
          $push: { entries: { $each: [{ label: 'added', token: 'entry-secret' }] } },
        },
      );
      assert.equal(result.matchedCount, 4);
      assert.equal(result.modifiedCount, 4);
      const values = await raw.find({ group: 'read' }).toArray();
      for (const value of values) {
        assert.equal(value.token, 'stored:rotated');
        assert.equal(value.profile.label, 'updated');
        assert.equal(value.entries[0].token, 'stored:entry-secret');
        assert.equal(value.entries[0].fixed, 'new');
        assert(value.updatedAt >= before!.updatedAt);
        assert.deepEqual(value.updatedAt, values[0]!.updatedAt);
      }
      assert.deepEqual((await raw.findOne({ name: 'a' }))!.createdAt, before!.createdAt);
      const read = await db.records
        .cursor({ group: 'read' }, { projection: { token: 1, entries: 1 } })
        .toArray();
      assert(read.every((x) => x.token === 'rotated' && x.entries[0]!.token === 'entry-secret'));
      assert.equal(
        (await db.records.updateMany({ name: 'absent' }, { $set: { token: 'none' } })).matchedCount,
        0,
      );
    },
  );

  await t.test(
    'findOneAndUpdate returns before/after plain documents with selection and sort',
    async () => {
      const before = await db.records.findOneAndUpdate(
        { group: 'read' },
        { $set: { name: 'renamed' } },
        { sort: { rank: 1 } },
      );
      assert.equal(before?.name, 'a');
      assert(before);
      assert.equal(before.token, 'rotated');
      assert(before._id instanceof ObjectId);
      assert.equal(Object.getPrototypeOf(before), Object.prototype);
      const after = await db.records.findOneAndUpdate(
        { name: 'renamed' },
        { $set: { token: 'new-token' } },
        { returnDocument: 'after', projection: { name: 1, token: 1, _id: 1 } },
      );
      assert.equal(after?.token, 'new-token');
      assert(after?._id instanceof ObjectId);
      assert.equal((await raw.findOne({ name: 'renamed' }))!.token, 'stored:new-token');
      const command = commands.filter((e) => e.name === 'findAndModify').at(-1)!.command;
      assert.equal(command.new, true);
      assert.equal(command.upsert, false);
      assert.equal(
        await db.records.findOneAndUpdate({ name: 'absent' }, { $set: { name: 'still-absent' } }),
        null,
      );
    },
  );

  await t.test(
    'delete methods share filters; findOneAndDelete applies projections and decoding',
    async () => {
      await db.records.insertMany([
        input('delete-a', 1, 'delete'),
        input('delete-b', 2, 'delete'),
        input('delete-c', 3, 'delete'),
      ]);
      const deleted = await db.records.findOneAndDelete(
        { group: 'delete' },
        { sort: { rank: -1 }, projection: { name: 1, token: 1, _id: 0 } },
      );
      assert.deepEqual(deleted, { name: 'delete-c', token: 'token-delete-c' });
      assert.equal(await db.records.exists({ name: 'delete-c' }), false);
      assert.equal((await db.records.deleteOne({ group: 'delete' })).deletedCount, 1);
      assert.equal((await db.records.deleteMany({ group: 'delete' })).deletedCount, 1);
      assert.equal((await db.records.deleteMany({ group: 'delete' })).deletedCount, 0);
      assert.equal(await db.records.findOneAndDelete({ group: 'delete' }), null);
      const defaultDeleted = await db.records.findOneAndDelete({ name: 'broken-b' });
      assert.equal(defaultDeleted?.token, 'token-broken-b');
      const projectedDeleted = await db.records.findOneAndDelete(
        { name: 'broken-a' },
        { projection: { token: 0 } },
      );
      assert(projectedDeleted);
      assert(!('token' in projectedDeleted));
    },
  );

  await t.test(
    'bulkWrite applies all supported operations, codecs, defaults and native counts',
    async () => {
      const a = input('bulk-a', 1, 'bulk');
      const b = input('bulk-b', 2, 'bulk');
      const result = await db.records.bulkWrite([
        { insertOne: { document: a } },
        { insertOne: { document: b } },
        { insertOne: { document: input('bulk-c', 3, 'bulk') } },
        {
          updateOne: {
            filter: { name: 'bulk-a' },
            update: { $set: { 'profile.token': 'changed' } },
          },
        },
        {
          updateMany: {
            filter: { group: 'bulk' },
            update: { $push: { entries: { label: 'bulk', token: 'encoded' } } },
            upsert: false,
          },
        },
        { deleteOne: { filter: { name: 'bulk-b' } } },
        { deleteMany: { filter: { name: 'bulk-c' } } },
      ]);
      assert.equal(result.insertedCount, 3);
      assert.equal(result.matchedCount, 4);
      assert.equal(result.modifiedCount, 4);
      assert.equal(result.deletedCount, 2);
      assert.equal(result.upsertedCount, 0);
      assert.equal(Object.keys(result.insertedIds).length, 3);
      assert(!('_id' in a));
      const stored = await raw.findOne({ name: 'bulk-a' });
      assert.equal(stored!.profile.token, 'stored:changed');
      assert.equal(stored!.entries[0].token, 'stored:encoded');
      assert.equal(stored!.fixed, 'original');
      assert.deepEqual(stored!.createdAt, stored!.updatedAt);
      assert.equal(await db.records.countDocuments({ group: 'bulk' }), 1);
    },
  );

  await t.test(
    'invalid batch members and unsupported writes reject before any write command',
    async () => {
      const before = writeCount();
      const invalid = { ...input('invalid', 0), token: 42 };
      await assert.rejects(
        db.records.insertMany([input('never-inserted', 0), invalid] as never, { ordered: false }),
        /expected string/,
      );
      await assert.rejects(
        db.records.bulkWrite(
          [
            { insertOne: { document: input('never-inserted', 0) } },
            { updateMany: { filter: {}, update: { $set: { 'profile.fixed': 'overwrite' } } } },
          ] as never,
          { ordered: false },
        ),
        /immutable/,
      );
      const badOperations = [
        {},
        { deleteOne: { filter: {} }, deleteMany: { filter: {} } },
        { replaceOne: { filter: {}, replacement: {} } },
        { updateOne: { filter: {}, update: { $set: { name: 'x' } }, upsert: true } },
        { updateOne: { filter: {}, update: [{ $set: { name: 'x' } }] } },
        { deleteMany: { filter: { token: 'plaintext' } } },
        { deleteMany: { filter: {}, collation: {} } },
        { deleteOne: undefined },
        { deleteOne: {} },
      ];
      for (const operation of badOperations)
        await assert.rejects(db.records.bulkWrite([operation] as never));
      await assert.rejects(db.records.bulkWrite([]), /nonempty/);
      await assert.rejects(db.records.insertMany([]), /nonempty/);
      const sparse: never[] = [];
      sparse.length = 1;
      await assert.rejects(db.records.insertMany(sparse), /plain object/);
      await assert.rejects(db.records.bulkWrite(sparse), /exactly one/);
      await assert.rejects(
        db.records.updateMany({}, { $set: { profile: { label: 'new', token: 'new' } } } as never),
        /immutable/,
      );
      await assert.rejects(
        db.records.findOneAndUpdate({}, { $set: { fixed: 'new' } } as never),
        /immutable/,
      );
      await assert.rejects(
        db.records.findOneAndUpdate({}, { $set: { name: 'new' } }, {
          returnDocument: 'invalid',
        } as never),
        /returnDocument/,
      );
      await assert.rejects(
        db.records.findOneAndUpdate({}, { $set: { name: 'new' } }, { upsert: true } as never),
        /required field/,
      );
      await assert.rejects(
        db.records.bulkWrite([{ deleteMany: { filter: {} } }], { ordered: 'false' } as never),
        /boolean/,
      );
      assert.equal(writeCount(), before);
      assert.equal(await db.records.exists({ name: 'never-inserted' }), false);
    },
  );

  await t.test('read validation and codec restrictions apply to every new query path', async () => {
    const before = commands.length;
    await assert.rejects(db.records.exists({ token: 'plaintext' }), /codec-backed/);
    await assert.rejects(db.records.countDocuments({ token: 'plaintext' }), /codec-backed/);
    await assert.rejects(db.records.deleteOne({ token: 'plaintext' }), /codec-backed/);
    await assert.rejects(db.records.deleteMany({ token: 'plaintext' }), /codec-backed/);
    await assert.rejects(db.records.findOneAndDelete({ token: 'plaintext' }), /codec-backed/);
    assert.throws(() => db.records.cursor({ token: 'plaintext' }), /codec-backed/);
    assert.throws(() => db.records.cursor({}, { sort: { token: 1 } }), /codec-backed/);
    assert.throws(() => db.records.cursor({}, { sort: { profile: 1 } }), /codec-backed/);
    assert.throws(() => db.records.cursor({}, { sort: { typo: 1 } } as never), /unknown/);
    assert.throws(
      () =>
        db.records.cursor(
          {},
          {
            sort: [
              ['rank', 1],
              ['rank', -1],
            ],
          },
        ),
      /duplicate/,
    );
    for (const options of [
      { skip: -1 },
      { limit: NaN },
      { batchSize: 0 },
      { limit: 1.5 },
      { sort: [] },
      { sort: { rank: 'asc' } },
      { projection: { name: 1, rank: 0 } },
      { projection: { typo: 1 } },
      { hint: '' },
    ]) {
      assert.throws(() => db.records.cursor({}, options as never));
    }
    await assert.rejects(db.records.countDocuments({}, { skip: -1 }), /integer/);
    await assert.rejects(db.records.findOne({}, { sort: { token: 1 } }), /codec-backed/);
    await assert.rejects(db.records.findOneAndDelete({}, { sort: { token: 1 } }), /codec-backed/);
    assert.equal(commands.length, before);
  });

  await t.test(
    'ordered/unordered server errors retain partial results without retries',
    async () => {
      await db.records.insertOne(input('duplicate', 0, 'errors'));
      for (const ordered of [true, false]) {
        const suffix = ordered ? 'ordered' : 'unordered';
        await assert.rejects(
          db.records.bulkWrite(
            [
              { insertOne: { document: input(`before-${suffix}`, 0, 'errors') } },
              { insertOne: { document: input('duplicate', 0, 'errors') } },
              { insertOne: { document: input(`after-${suffix}`, 0, 'errors') } },
            ],
            { ordered },
          ),
          (error: unknown) => {
            assert(error instanceof MongoBulkWriteError);
            assert.equal(error.code, 11000);
            assert.equal(error.result.insertedCount, ordered ? 1 : 2);
            assert.equal(error.result.getWriteErrors()[0]!.index, 1);
            return true;
          },
        );
        assert.equal(await db.records.exists({ name: `before-${suffix}` }), true);
        assert.equal(await db.records.exists({ name: `after-${suffix}` }), !ordered);
      }
      await assert.rejects(
        db.records.insertMany(
          [input('duplicate', 0, 'errors'), input('insert-after-error', 0, 'errors')],
          { ordered: false },
        ),
        (error: unknown) => {
          assert(error instanceof MongoBulkWriteError);
          assert.equal(error.result.insertedCount, 1);
          return true;
        },
      );
      assert.equal(await db.records.exists({ name: 'insert-after-error' }), true);
    },
  );
});
