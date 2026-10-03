import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Collection, Document } from 'mongodb';
import { bindCollection } from '../packages/db/src/collection.js';
import {
  collection,
  customType,
  map,
  number,
  object,
  string,
  timestamps,
} from '../packages/db/src/index.js';
import { encodeUpsert } from '../packages/db/src/upsert.js';

test('upsert fills insertion defaults once and shares encoded values with the update', () => {
  let encodes = 0;
  let defaults = 0;
  const secret = customType({
    base: string,
    codec: {
      encode: (v: string) => {
        encodes++;
        return `stored:${v}`;
      },
      decode: (v: string) => v.slice(7),
      storedSchema: { bsonType: 'string' },
    },
  });
  const fields = {
    _id: string(),
    profile: object({
      secret: secret(),
      count: number().default(() => {
        defaults++;
        return 5;
      }),
    }),
    fixed: string().immutable(),
    ...timestamps(),
  };
  const now = new Date();
  const result = encodeUpsert(
    fields,
    { _id: 'id' },
    { $set: { 'profile.secret': 'value' }, $setOnInsert: { fixed: 'original' } },
    now,
    true,
  );
  assert.equal(encodes, 1);
  assert.equal(defaults, 1);
  assert.deepEqual(result, {
    $set: { 'profile.secret': 'stored:value', updatedAt: now },
    $setOnInsert: { _id: 'id', 'profile.count': 5, fixed: 'original', createdAt: now },
  });
  for (const update of [
    { $set: { fixed: 'changed' } },
    { $inc: { 'profile.count': 1 } },
    { $set: { fixed: 'x' }, $setOnInsert: { fixed: 'y' } },
    { $set: null },
    { $setOnInsert: { typo: true } },
  ])
    assert.throws(() => encodeUpsert(fields, { _id: 'id' }, update, now, true));
});

test('upserts validate application numbers before the BSON query snapshot', async () => {
  const schema = collection('numeric_upserts', {
    _id: string(),
    count: number(),
    profile: object({ score: number() }),
  });
  let captured: Document | undefined;
  const native = {
    async updateOne(_filter: Document, update: Document) {
      captured = update;
      return {};
    },
  } as unknown as Collection;
  const records = bindCollection(native, schema, () => {});
  await records.updateOne(
    { _id: 'one', count: { $eq: 3 }, profile: { score: 1.5 } },
    { $setOnInsert: {} },
    { upsert: true },
  );
  assert.deepEqual(captured, {
    $setOnInsert: { _id: 'one', count: 3, profile: { score: 1.5 } },
  });
});

test('map entry upserts split insert-only siblings without conflicting with the set path', () => {
  const fields = { _id: string(), counts: map(number()) };
  assert.deepEqual(
    encodeUpsert(
      fields,
      { _id: 'one', counts: { old: 2 } },
      { $set: { 'counts.next': 3 } },
      new Date(),
      true,
    ),
    { $set: { 'counts.next': 3 }, $setOnInsert: { _id: 'one', 'counts.old': 2 } },
  );
});

test('increment upserts start missing fields at zero and validate the resulting insertion', () => {
  let defaults = 0;
  const fields = {
    _id: string(),
    count: number()
      .min(0)
      .max(10)
      .default(() => {
        defaults++;
        return 9;
      }),
    nested: object({ count: number(), label: string().default('new') }),
    counts: map(number()),
  };
  const result = encodeUpsert(
    fields,
    { _id: 'one', 'counts.old': 4 },
    {
      $inc: { count: 2, 'nested.count': 3, 'counts.old': 1 },
    },
    new Date(),
    false,
  );
  assert.deepEqual(result, {
    $inc: { count: 2, 'nested.count': 3, 'counts.old': 1 },
    $setOnInsert: { _id: 'one', 'nested.label': 'new' },
  });
  assert.equal(defaults, 0);
  const simple = { _id: string(), count: number().integer().min(0).max(10) };
  for (const [filter, update] of [
    [{ _id: 'one' }, { $inc: { count: -1 } }],
    [{ _id: 'one', count: 10 }, { $inc: { count: 1 } }],
    [{ _id: 'one', count: null }, { $inc: { count: 1 } }],
    [{ _id: 'one', count: undefined }, { $inc: { count: 1 } }],
    [{ _id: 'one' }, { $inc: { count: 0.5 } }],
    [{ _id: 'one' }, { $inc: { count: 1 }, $setOnInsert: { count: 0 } }],
    [{ _id: 'one' }, { $inc: { count: 1 }, $set: { count: 0 } }],
  ] as const)
    assert.throws(() => encodeUpsert(simple, filter, update, new Date(), true));
});

test('increment upserts reject explicit undefined inside equality objects', () => {
  const fields = { _id: string(), nested: object({ count: number() }) };
  assert.throws(
    () =>
      encodeUpsert(
        fields,
        { _id: 'one', nested: { count: undefined } },
        {
          $inc: { 'nested.count': 1 },
        },
        new Date(),
        true,
      ),
    /finite number/,
  );
});
