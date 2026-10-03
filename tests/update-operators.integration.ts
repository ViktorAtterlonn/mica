import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MongoClient, MongoServerError, type Document } from 'mongodb';
import {
  collection,
  createDatabase,
  customType,
  jsonSchema,
  number,
  object,
  objectId,
  string,
  timestamps,
} from '../src/index.js';

const uri = process.env.MICA_TEST_URI;
if (!uri) throw new Error('Use npm run test:integration for an isolated MongoDB container');

test('$unset and $inc preserve native atomic writes with Mica field rules', async (t) => {
  let encodes = 0;
  const secret = customType({
    base: string,
    codec: {
      encode: (value: string) => {
        encodes++;
        return `stored:${value}`;
      },
      decode: (value: string) => value.slice(7),
      storedSchema: { bsonType: 'string' },
    },
  });
  const Records = collection('records', {
    _id: objectId().auto(),
    name: string(),
    count: number().integer().default(0),
    bounded: number().integer().min(10).max(20).default(15),
    optional: number().optional().default(100),
    nullable: number().nullable().default(null),
    token: secret().optional(),
    profile: object({ name: string(), token: secret().optional() }).optional(),
    frozen: number().optional().immutable(),
    ...timestamps(),
  });
  const client = new MongoClient(uri, { monitorCommands: true });
  const commands: { name: string; command: Document }[] = [];
  client.on('commandStarted', (event) => {
    commands.push({ name: event.commandName, command: event.command });
  });
  const db = createDatabase({
    client,
    database: 'mica_update_operators',
    collections: { records: Records },
  });
  t.after(() => db.close());
  await db.connect();
  await client
    .db('mica_update_operators')
    .createCollection('records', { validator: jsonSchema(Records) });
  const raw = client.db('mica_update_operators').collection('records');

  await t.test('concurrent increments are atomic and issue no preliminary reads', async () => {
    const { insertedId } = await db.records.insertOne({ name: 'atomic' });
    const filter = { _id: insertedId };
    commands.length = 0;
    await Promise.all(
      Array.from({ length: 30 }, () => db.records.updateOne(filter, { $inc: { count: 1 } })),
    );
    assert.equal(commands.filter(({ name }) => name === 'find').length, 0);
    const updates = commands.filter(({ name }) => name === 'update');
    assert.equal(updates.length, 30);
    for (const { command } of updates) {
      assert.deepEqual(command.updates[0].u.$inc, { count: 1 });
      assert(command.updates[0].u.$set.updatedAt instanceof Date);
    }
    assert.equal((await db.records.findOne(filter))?.count, 30);
  });

  await t.test(
    'removal skips codecs and defaults; missing and null increments follow MongoDB',
    async () => {
      const { insertedId } = await db.records.insertOne({
        name: 'optional',
        token: 'secret',
        profile: { name: 'Person', token: 'nested' },
      });
      const filter = { _id: insertedId };
      const beforeEncodes = encodes;
      await db.records.updateOne(filter, { $unset: { token: 1, optional: true, profile: '' } });
      assert.equal(encodes, beforeEncodes);
      const removed = await raw.findOne(filter);
      assert(removed);
      for (const key of ['token', 'optional', 'profile']) assert(!Object.hasOwn(removed, key));
      assert.equal((await db.records.findOne(filter))?.optional, undefined);
      await db.records.updateOne(filter, { $unset: { token: 1 } });
      await db.records.updateOne(filter, { $inc: { optional: 3 } });
      assert.equal((await db.records.findOne(filter))?.optional, 3);
      await assert.rejects(
        db.records.updateOne(filter, { $inc: { nullable: 1 } }),
        (error: unknown) => {
          assert(error instanceof MongoServerError);
          assert.match(error.message, /null/);
          return true;
        },
      );
      assert.equal((await db.records.findOne(filter))?.nullable, null);
    },
  );

  await t.test('installed validators constrain the result rather than the delta', async () => {
    const { insertedId } = await db.records.insertOne({ name: 'bounded' });
    const filter = { _id: insertedId };
    await db.records.updateOne(filter, { $inc: { bounded: -2 } });
    assert.equal((await db.records.findOne(filter))?.bounded, 13);
    for (const delta of [-4, 8]) {
      await assert.rejects(
        db.records.updateOne(filter, { $inc: { bounded: delta } }),
        (error: unknown) => {
          assert(error instanceof MongoServerError);
          assert.equal(error.code, 121);
          return true;
        },
      );
    }
    assert.equal((await db.records.findOne(filter))?.bounded, 13);
  });

  await t.test('updateMany, returned documents and bulk writes use both operators', async () => {
    const inserted = await db.records.insertMany([
      { name: 'batch', token: 'a' },
      { name: 'batch', token: 'b' },
    ]);
    const first = { _id: inserted.insertedIds[0]! };
    const many = await db.records.updateMany(
      { name: 'batch' },
      { $inc: { count: 2 }, $unset: { token: 1 } },
    );
    assert.equal(many.modifiedCount, 2);
    const before = await db.records.findOneAndUpdate(
      first,
      { $inc: { count: 1 }, $unset: { optional: 1 } },
      { projection: { count: 1, optional: 1, _id: 0 } },
    );
    assert.deepEqual(before, { count: 2, optional: 100 });
    const after = await db.records.findOneAndUpdate(
      first,
      { $inc: { optional: 4 }, $unset: { token: 1 } },
      { returnDocument: 'after', projection: { count: 1, optional: 1, token: 1, _id: 0 } },
    );
    assert.deepEqual(after, { count: 3, optional: 4 });
    await db.records.bulkWrite([
      { updateOne: { filter: first, update: { $inc: { count: 1 }, $unset: { optional: 1 } } } },
      {
        updateMany: {
          filter: { name: 'batch' },
          update: { $inc: { count: 2 }, $unset: { optional: 1 } },
        },
      },
    ]);
    const results = await db.records.find({ name: 'batch' }, { sort: { count: 1 } });
    assert.deepEqual(
      results.map(({ count }) => count),
      [4, 6],
    );
    for (const result of results) {
      assert(!Object.hasOwn(result, 'optional'));
      assert(!Object.hasOwn(result, 'token'));
      assert(result.updatedAt instanceof Date);
    }
  });

  await t.test(
    'invalid operations preflight every update entry point and the entire bulk',
    async () => {
      commands.length = 0;
      for (const update of [
        { $unset: { name: 1 } },
        { $unset: { frozen: 1 } },
        { $inc: { frozen: 1 } },
        { $inc: { count: 0.5 } },
        { $inc: { token: 1 } },
        { $inc: { optional: 1 }, $unset: { optional: 1 } },
      ]) {
        await assert.rejects(db.records.updateOne({}, update as never));
        await assert.rejects(db.records.updateMany({}, update as never));
        await assert.rejects(db.records.findOneAndUpdate({}, update as never));
        await assert.rejects(
          db.records.bulkWrite(
            [
              { insertOne: { document: { name: 'must not be inserted' } } },
              { updateMany: { filter: {}, update: update as never } },
            ],
            { ordered: false },
          ),
        );
      }
      assert.deepEqual(
        commands.filter(({ name }) =>
          ['insert', 'update', 'findAndModify', 'bulkWrite'].includes(name),
        ),
        [],
      );
      assert.equal(await db.records.exists({ name: 'must not be inserted' }), false);
    },
  );
});
