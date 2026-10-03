import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MongoClient, type Document } from 'mongodb';
import {
  array,
  collection,
  createDatabase,
  customType,
  jsonSchema,
  object,
  objectId,
  string,
} from '../src/index.js';

const uri = process.env.MICA_TEST_URI;
if (!uri) throw new Error('Use npm run test:integration for an isolated MongoDB container');

test('MongoDB returns all fields by default and excludes projected values before decoding and immutable rejections send no writes', async (t) => {
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
  const Records = collection('records', {
    _id: objectId().auto(),
    name: string(),
    token: secret(),
    profile: object({ name: string(), token: secret(), fixed: string().immutable() }),
    rows: array(object({ token: secret(), fixed: string().immutable() })),
    matrix: array(array(object({ token: secret() }))),
    consent: array(objectId()).immutable(),
    frozen: object({ value: string() }).immutable(),
  });
  const client = new MongoClient(uri, { monitorCommands: true });
  const finds: Document[] = [];
  let writes = 0;
  client.on('commandStarted', (e) => {
    if (e.commandName === 'find') finds.push(e.command);
    if (e.commandName === 'update') writes++;
  });
  const db = createDatabase({
    client,
    database: 'mica_field_options',
    collections: { records: Records },
  });
  t.after(() => db.close());
  await db.connect();
  await client
    .db('mica_field_options')
    .createCollection('records', { validator: jsonSchema(Records) });
  const { insertedId } = await db.records.insertOne({
    name: 'test',
    token: 'top secret',
    profile: { name: 'person', token: 'nested secret', fixed: 'original' },
    rows: [{ token: 'array secret', fixed: 'first' }],
    matrix: [[{ token: 'matrix secret' }]],
    consent: [],
    frozen: { value: 'original' },
  });
  const filter = { _id: insertedId };
  const result = await db.records.findOne(filter);
  assert(result);
  assert(result._id.equals(insertedId));
  assert.equal(result.token, 'top secret');
  assert.equal(result.profile.token, 'nested secret');
  assert.equal(result.rows[0]!.token, 'array secret');
  assert.deepEqual(result.matrix, [[{ token: 'matrix secret' }]]);
  assert.equal(decodes, 4);
  assert.deepEqual(finds.at(-1)!.projection, {});
  assert.deepEqual(await db.records.findOne(filter, { projection: {} }), result);
  assert.equal(decodes, 8);
  const projection = { token: 0, 'profile.token': 0, 'rows.token': 0, 'matrix.token': 0 } as const;
  const excluded = await db.records.findOne(filter, { projection });
  assert(excluded);
  assert(excluded._id.equals(insertedId));
  assert(!('token' in excluded));
  assert(!('token' in excluded.profile));
  assert(!('token' in excluded.rows[0]!));
  assert.deepEqual(excluded.matrix, [[{}]]);
  assert.equal(decodes, 8);
  assert.deepEqual(finds.at(-1)!.projection, projection);
  assert.deepEqual(await db.records.findOne(filter, { projection: { name: 1 } }), {
    _id: insertedId,
    name: 'test',
  });
  assert.equal(decodes, 8);
  assert.deepEqual(await db.records.findOne(filter, { projection: { token: 1 } }), {
    _id: insertedId,
    token: 'top secret',
  });
  assert.equal(decodes, 9);
  const selected = await db.records.findOne(filter, {
    projection: { profile: 1, rows: 1, matrix: 1, _id: 1 },
  });
  assert(selected);
  assert(selected._id.equals(insertedId));
  assert.equal(selected.profile.token, 'nested secret');
  assert.equal(selected.rows[0]!.token, 'array secret');
  assert.equal(selected.matrix[0]![0]!.token, 'matrix secret');
  assert.equal(decodes, 12);
  for (const update of [
    { $set: { profile: { name: 'overwrite', token: 'oops', fixed: 'new' } } },
    { $set: { 'profile.fixed': 'new' } },
    { $set: { 'frozen.value': 'new' } },
    { $set: { rows: [] } },
    { $push: { consent: { $each: [] } } },
  ])
    await assert.rejects(db.records.updateOne(filter, update as never), /immutable/);
  assert.equal(writes, 0);
  await db.records.updateOne(filter, {
    $set: { 'profile.name': 'changed', token: 'rotated' },
    $push: { rows: { fixed: 'second', token: 'new' } },
  });
  const updated = await db.records.findOne(filter);
  assert.equal(updated?.profile.name, 'changed');
  assert.equal(updated?.profile.fixed, 'original');
  assert.equal(updated?.rows.length, 2);
  assert.equal(updated?.token, 'rotated');
  assert.equal(decodes, 17);
  assert.deepEqual(await db.records.findOne(filter, { projection: { token: 1 } }), {
    _id: insertedId,
    token: 'rotated',
  });
});
