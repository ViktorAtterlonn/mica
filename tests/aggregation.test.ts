import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BSON, type Collection, type Document } from 'mongodb';
import {
  array,
  collection,
  customType,
  map,
  MicaValidationError,
  number,
  object,
  string,
} from '../packages/db/src/index.js';
import { bindCollection } from '../packages/db/src/collection.js';

const secret = customType({
  base: string,
  codec: {
    encode: (value: string) => `stored:${value}`,
    decode: (value: string) => value.slice(7),
    storedSchema: { bsonType: 'string' },
  },
});
const Records = collection('records', {
  _id: string(),
  name: string(),
  amount: number(),
  secret: secret(),
  profile: object({ name: string(), secret: secret() }),
  rows: array(object({ amount: number() })),
  counts: map(number()),
});

test('aggregation branches snapshot stages and options without executing them', async () => {
  const calls: Document[] = [];
  const native = {
    aggregate(pipeline: Document[], options: Document) {
      calls.push(BSON.deserialize(BSON.serialize({ pipeline, options })));
      return { toArray: async () => [], close: async () => {} };
    },
  } as unknown as Collection;
  const bound = bindCollection(native, Records, () => {});
  const filter = { amount: { $gt: 10 } };
  const collation = { locale: 'en', strength: 1 };
  const options = { collation, allowDiskUse: true, batchSize: 2, timeoutMS: 5000, maxTimeMS: 1000 };
  const base = bound.aggregate(options).match(filter);
  const group = { _id: '$name', total: { $sum: '$amount' } } as const;
  const grouped = base.group(group).sort({ total: -1 });
  const projected = base.project({ name: 1, _id: 0 }).limit(3).skip(1);
  filter.amount.$gt = 999;
  collation.locale = 'invalid';
  options.batchSize = 100;
  Object.assign(group, { _id: '$secret' });
  assert.equal(calls.length, 0);
  await grouped.toArray();
  await projected.toArray();
  await base.toArray();
  await grouped.toArray();
  assert.deepEqual(calls[0]!.pipeline, [
    { $match: { amount: { $gt: 10 } } },
    { $group: { _id: '$name', total: { $sum: '$amount' } } },
    { $sort: { total: -1 } },
  ]);
  assert.deepEqual(calls[1]!.pipeline, [
    { $match: { amount: { $gt: 10 } } },
    { $project: { name: 1, _id: 0 } },
    { $limit: 3 },
    { $skip: 1 },
  ]);
  assert.deepEqual(calls[2]!.pipeline, [{ $match: { amount: { $gt: 10 } } }]);
  assert.deepEqual(calls[0], calls[3]);
  assert.equal(calls[0]!.options.collation.locale, 'en');
  assert.equal(calls[0]!.options.batchSize, 2);
});

test('aggregation rejects invalid stages and options before contacting MongoDB', () => {
  const bound = bindCollection({} as Collection, Records, () => {});
  const base = bound.aggregate();
  for (const spec of [
    {},
    { _id: '$typo' },
    { _id: '$secret' },
    { _id: '$profile' },
    { _id: '$rows.amount' },
    { _id: '$counts.one' },
    { _id: '$$ROOT' },
    { _id: null, total: { $sum: '$name' } },
    { _id: null, total: { $sum: Infinity } },
    { _id: null, total: { $sum: 1, $avg: '$amount' } },
    { _id: null, total: { $push: '$amount' } },
    { _id: null, 'bad.name': { $sum: 1 } },
    { _id: null, constructor: { $sum: 1 } },
  ])
    assert.throws(() => base.group(spec as never), MicaValidationError);
  for (const value of [0, -1, 0.5, Infinity, '1'])
    assert.throws(() => base.limit(value as never), MicaValidationError);
  for (const name of ['', '_id', '$name', 'bad.name', 'constructor', '__proto__', 1])
    assert.throws(() => base.count(name as never), MicaValidationError);
  for (const options of [
    { allowDiskUse: 1 },
    { batchSize: 0 },
    { timeoutMS: -1 },
    { explain: true },
    { signal: {} },
  ]) {
    assert.throws(() => bound.aggregate(options as never), MicaValidationError);
  }
  assert.throws(() => base.match({ secret: 'plaintext' }), /codec/);
  assert.throws(() => base.sort({ secret: 1 }), /codec/);
  assert.throws(() => base.project({ 'counts.one': 1 } as never), /whole maps/);
  assert.throws(() => base.project({ name: 1 }).match({ amount: 1 } as never), MicaValidationError);
  assert.throws(
    () => base.group({ _id: null, total: { $sum: 1 } }).sort({ amount: 1 } as never),
    MicaValidationError,
  );
  assert.throws(() => base.count('total').project({ name: 1 } as never), MicaValidationError);
});

test('aggregation closes on driver or decoder failure and preserves the original error', async () => {
  const failure = new Error('decode failed');
  const broken = customType({
    base: string,
    codec: {
      encode: (value: string) => value,
      decode: (_value: string): string => {
        throw failure;
      },
      storedSchema: { bsonType: 'string' },
    },
  });
  const schema = collection('broken', { _id: string(), value: broken() });
  let closes = 0;
  let driverFailure = false;
  let disconnected = false;
  let commands = 0;
  const native = {
    aggregate() {
      commands++;
      return {
        toArray: async () => {
          if (driverFailure) throw failure;
          return [{ _id: 'one', value: 'stored' }];
        },
        close: async () => {
          closes++;
          throw new Error('close failed');
        },
      };
    },
  } as unknown as Collection;
  const bound = bindCollection(native, schema, () => {
    if (disconnected) throw new Error('connect first');
  });
  const controller = new AbortController();
  const pipeline = bound.aggregate({ signal: controller.signal });
  await assert.rejects(pipeline.toArray(), (error) => error === failure);
  driverFailure = true;
  await assert.rejects(pipeline.toArray(), (error) => error === failure);
  assert.equal(closes, 2);
  disconnected = true;
  await assert.rejects(pipeline.toArray(), /connect/);
  disconnected = false;
  controller.abort(failure);
  await assert.rejects(pipeline.toArray(), (error) => error === failure);
  assert.equal(commands, 2);
});
