import assert from 'node:assert/strict';
import { test } from 'node:test';
import { array, customType, number, object, objectId, string, timestamps } from '../src/index.js';
import { checkFilter } from '../src/filter.js';
import { encodeUpdate, prepareArrayFilters } from '../src/update.js';

const secret = customType({
  base: string,
  codec: {
    encode: (value: string) => `x:${value}`,
    decode: (value: string) => value.slice(2),
    storedSchema: { bsonType: 'string' },
  },
});
const fields = {
  labels: array(string()),
  counts: array(number()),
  ids: array(objectId()),
  fixed: array(string()).immutable(),
  fixedElements: array(string().immutable()),
  rows: array(object({ value: string() })),
  secrets: array(secret()),
  ...timestamps(),
};
const now = new Date();

test('scalar set additions and removals preserve MongoDB operands and timestamps', () => {
  assert.deepEqual(
    encodeUpdate(
      fields,
      { $addToSet: { labels: { $each: ['a', 'b'] } }, $pull: { counts: { $gte: 3 } } },
      now,
    ),
    {
      $addToSet: { labels: { $each: ['a', 'b'] } },
      $pull: { counts: { $gte: 3 } },
      $set: { updatedAt: now },
    },
  );
  assert.deepEqual(encodeUpdate(fields, { $pull: { labels: /^old/ } }, now).$pull, {
    labels: /^old/,
  });
  assert.deepEqual(encodeUpdate(fields, { $addToSet: { fixedElements: 'new' } }, now).$addToSet, {
    fixedElements: 'new',
  });
});

test('array operations reject codecs, invalid containers, immutable removal and conflicts', () => {
  for (const operator of ['$addToSet', '$pull']) {
    for (const path of ['secrets', 'rows', 'fixed', 'updatedAt', 'typo']) {
      assert.throws(() => encodeUpdate(fields, { [operator]: { [path]: 'a' } }, now));
    }
  }
  for (const update of [
    { $pull: { fixedElements: 'a' } },
    { $pull: { labels: { $where: 'code' } } },
    { $pull: { labels: undefined } },
    { $addToSet: { counts: 'wrong' } },
    { $addToSet: { labels: { $each: ['x'], $slice: 1 } } },
    { $addToSet: { labels: 'x' }, $pull: { labels: 'y' } },
  ])
    assert.throws(() => encodeUpdate(fields, update, now));
});

test('min/max accept validated numeric candidates and preserve update protections', () => {
  const values = {
    score: number().min(0).max(10),
    fixed: number().immutable(),
    secret: customType({
      base: number,
      codec: {
        encode: (v: number) => v,
        decode: (v: number) => v,
        storedSchema: { bsonType: 'number' },
      },
    })(),
  };
  assert.deepEqual(encodeUpdate(values, { $max: { score: 5 } }, now), { $max: { score: 5 } });
  for (const update of [
    { $min: { score: -1 } },
    { $max: { score: Infinity } },
    { $min: { fixed: 1 } },
    { $max: { secret: 1 } },
    { $max: { score: null } },
  ])
    assert.throws(() => encodeUpdate(values, update, now));
});

test('richer filter validation follows schema structure and checks nested codec boundaries', () => {
  const filterFields = { ...fields, rows: array(object({ name: string(), token: secret() })) };
  for (const filter of [
    { rows: { $elemMatch: { name: { $regex: '^a', $options: 'i' } } } },
    { rows: { $size: 1 } },
    { labels: { $not: { $all: ['a'] } } },
    { counts: { $elemMatch: { $gte: 2 } } },
  ])
    assert.doesNotThrow(() => checkFilter(filterFields, filter));
  for (const filter of [
    { rows: { $elemMatch: { token: 'secret' } } },
    { rows: { $not: { $elemMatch: { token: { $regex: 'secret' } } } } },
    { labels: { $size: -1 } },
    { labels: { $size: 1.5 } },
    { labels: { $all: 'a' } },
    { labels: { $all: [{ $elemMatch: { $eq: 'a' } }] } },
    { labels: { $options: 'i' } },
    { labels: { $regex: 'a', $options: 'g' } },
    { counts: { $regex: 'a' } },
    { counts: { $not: {} } },
    { counts: { $type: 'invalid' } },
    { counts: { $elemMatch: { $where: 'code' } } },
  ])
    assert.throws(() => checkFilter(filterFields, filter));
});

test('push modifiers validate sorting, trimming, and modifier combinations', () => {
  assert.deepEqual(
    encodeUpdate(
      fields,
      { $push: { counts: { $each: [2, 1], $position: 0, $sort: 1, $slice: -2 } } },
      now,
      false,
    ),
    { $push: { counts: { $each: [2, 1], $position: 0, $sort: 1, $slice: -2 } } },
  );
  for (const update of [
    { $push: { counts: { $each: [], $position: 0.5 } } },
    { $push: { counts: { $each: [], $sort: 2 } } },
    { $push: { secrets: { $each: [], $sort: 1 } } },
    { $push: { fixedElements: { $each: [], $slice: 1 } } },
    { $push: { rows: { $each: [], $sort: { typo: 1 } } } },
  ])
    assert.throws(() => encodeUpdate(fields, update, now));
});

test('positional updates bind filters, reject immutable paths, and detect selector overlap', () => {
  const values = {
    rows: array(
      object({ name: string(), count: number(), secret: secret(), fixed: string().immutable() }),
    ),
  };
  const update = { $inc: { 'rows.$[row].count': 1 } };
  assert.deepEqual(prepareArrayFilters(values, update, [{ 'row.name': 'a' }]), [
    { 'row.name': 'a' },
  ]);
  for (const filters of [
    undefined,
    [],
    [{ 'row.secret': 'a' }],
    [{ 'other.name': 'a' }],
    [{ 'row.name': 'a' }, { 'row.name': 'b' }],
  ])
    assert.throws(() => prepareArrayFilters(values, update, filters));
  for (const change of [
    { $set: { 'rows.0.fixed': 'x' } },
    { $set: { 'rows.$[].fixed': 'x' } },
    { $set: { 'rows.$[Row].name': 'x' } },
    { $set: { 'rows.-1.name': 'x' } },
    { $inc: { 'rows.0.count': 1, 'rows.$[].count': 1 } },
    { $set: { 'rows.$[row]': { name: 'a', count: 1, secret: 's', fixed: 'f' } } },
  ])
    assert.throws(() => encodeUpdate(values, change, now));
  assert.deepEqual(encodeUpdate(values, { $set: { 'rows.0.secret': 's' } }, now), {
    $set: { 'rows.0.secret': 'x:s' },
  });
});

test('object pull predicates validate safe fields without codecs or insertion defaults', () => {
  const records = {
    rows: array(object({ id: string(), secret: secret(), count: number().default(10) })),
  };
  assert.deepEqual(encodeUpdate(records, { $pull: { rows: { id: 'one' } } }, now), {
    $pull: { rows: { id: 'one' } },
  });
  assert.throws(
    () => encodeUpdate(records, { $pull: { rows: { secret: 'plain' } } }, now),
    /codec/,
  );
  assert.throws(() => encodeUpdate(records, { $pull: { rows: { typo: true } } }, now), /path/);
  const fixed = { rows: array(object({ id: string().immutable(), name: string() })) };
  assert.throws(() => encodeUpdate(fixed, { $pull: { rows: { name: 'one' } } }, now), /immutable/);
});
