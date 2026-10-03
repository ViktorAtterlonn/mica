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

test('MongoDB excludes hidden values before decoding and immutable rejections send no writes', async (t) => {
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
    _id: objectId().auto().select(false),
    name: string(),
    token: secret().select(false),
    profile: object({ name: string(), token: secret().select(false), fixed: string().immutable() }),
    rows: array(object({ token: secret().select(false), fixed: string().immutable() })),
    matrix: array(array(object({ token: secret().select(false) }))),
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
  assert(!('_id' in result));
  assert(!('token' in result));
  assert(!('token' in result.profile));
  assert(!('token' in result.rows[0]!));
  assert.deepEqual(result.matrix, [[{}]]);
  assert.equal(decodes, 0);
  assert.deepEqual(finds.at(-1)!.projection, {
    _id: 0,
    token: 0,
    'profile.token': 0,
    'rows.token': 0,
    'matrix.token': 0,
  });
  assert.deepEqual(await db.records.findOne(filter, { projection: {} }), result);
  const excluded = await db.records.findOne(filter, { projection: { profile: 0, _id: 1 } });
  assert(excluded);
  assert(excluded._id.equals(insertedId));
  assert(!('profile' in excluded));
  assert(!('token' in excluded));
  assert.equal(decodes, 0);
  assert.deepEqual(await db.records.findOne(filter, { projection: { name: 1 } }), { name: 'test' });
  assert.deepEqual(await db.records.findOne(filter, { projection: { token: 1 } }), {
    token: 'top secret',
  });
  assert.equal(decodes, 1);
  const selected = await db.records.findOne(filter, {
    projection: { profile: 1, rows: 1, matrix: 1, _id: 1 },
  });
  assert(selected);
  assert(selected._id.equals(insertedId));
  assert.equal(selected.profile.token, 'nested secret');
  assert.equal(selected.rows[0]!.token, 'array secret');
  assert.equal(selected.matrix[0]![0]!.token, 'matrix secret');
  assert.equal(decodes, 4);
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
  assert.equal(decodes, 4);
  assert.deepEqual(await db.records.findOne(filter, { projection: { token: 1 } }), {
    token: 'rotated',
  });
});
