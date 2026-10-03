import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeUpdate } from '../src/update.js';
import { array, customType, number, object, objectId, string, timestamps } from '../src/index.js';

const forbiddenCall = () => {
  throw new Error('Update unexpectedly invoked a codec or default');
};

const encodedNumber = customType({
  base: number,
  codec: {
    encode: (_value: number): number => forbiddenCall(),
    decode: (_value: number): number => forbiddenCall(),
    storedSchema: { bsonType: 'number' },
  },
});

const fields = {
  _id: objectId().auto(),
  title: string(),
  count: number().integer().min(10).max(20),
  fractional: number(),
  nullable: number().nullable(),
  defaulted: number().default(forbiddenCall),
  optional: number().optional().default(forbiddenCall),
  secret: encodedNumber().optional(),
  annotated: customType({ base: number, metadata: { unit: 'items' } })(),
  details: object({ count: number(), label: string().optional() }).optional(),
  rows: array(object({ label: string() })).optional(),
  frozen: number().optional().immutable(),
  locked: object({ count: number().optional() }).optional().immutable(),
  protected: object({ fixed: string().immutable() }).optional(),
  protectedRows: array(object({ fixed: string().immutable() })).optional(),
  ...timestamps(),
};
const now = new Date('2026-10-02T12:00:00Z');

test('update operators combine without encoding deltas, invoking defaults, or mutating input', () => {
  const update = Object.freeze({
    $set: Object.freeze({ title: 'Changed' }),
    $inc: Object.freeze({ count: -1, fractional: 0.5, annotated: 0, defaulted: 1 }),
    $unset: Object.freeze({ secret: 1, optional: '', 'details.label': true }),
    $push: Object.freeze({ rows: { label: 'New' } }),
  });
  assert.deepEqual(encodeUpdate(fields, update, now), {
    ...update,
    $set: { title: 'Changed', updatedAt: now },
  });
  assert.deepEqual(encodeUpdate(fields, { $unset: { details: 1, rows: true } }, now), {
    $unset: { details: 1, rows: true },
    $set: { updatedAt: now },
  });
  // Bounds describe the result, not the operand; MongoDB checks the result.
  assert.deepEqual(encodeUpdate(fields, { $inc: { count: 100, optional: -2 } }, now), {
    $inc: { count: 100, optional: -2 },
    $set: { updatedAt: now },
  });
});

test('$unset requires optional, unprotected paths and driver-compatible markers', () => {
  for (const path of ['title', 'count', 'nullable', 'defaulted', 'details.count']) {
    assert.throws(() => encodeUpdate(fields, { $unset: { [path]: 1 } }, now), /optional/);
  }
  for (const path of [
    '_id',
    'frozen',
    'locked',
    'locked.count',
    'protected',
    'protectedRows',
    'createdAt',
    'updatedAt',
  ]) {
    assert.throws(() => encodeUpdate(fields, { $unset: { [path]: 1 } }, now), /immutable/);
  }
  for (const marker of [false, 0, null, undefined, 'remove', {}, []]) {
    assert.throws(
      () => encodeUpdate(fields, { $unset: { optional: marker } }, now),
      /empty string, true, or 1/,
    );
  }
});

test('$inc validates numeric operands and refuses codecs and protected paths', () => {
  for (const delta of ['1', NaN, Infinity, -Infinity, null, undefined, {}, []]) {
    assert.throws(() => encodeUpdate(fields, { $inc: { count: delta } }, now), /finite numeric/);
  }
  assert.throws(() => encodeUpdate(fields, { $inc: { count: 0.5 } }, now), /integer delta/);
  for (const path of ['title', 'secret', 'details', 'rows']) {
    assert.throws(
      () => encodeUpdate(fields, { $inc: { [path]: 1 } }, now),
      /number field without a codec/,
    );
  }
  for (const path of ['_id', 'frozen', 'locked.count', 'createdAt', 'updatedAt']) {
    assert.throws(() => encodeUpdate(fields, { $inc: { [path]: 1 } }, now), /immutable/);
  }
});

test('new operators retain path resolution, conflicts, and empty-update checks', () => {
  for (const update of [
    { $unset: { optional: 1 }, $inc: { optional: 1 } },
    { $inc: { optional: 1 }, $set: { optional: 2 } },
    { $unset: { details: 1 }, $inc: { 'details.count': 1 } },
    { $inc: { 'details.count': 1 }, $unset: { details: 1 } },
    { $unset: { rows: 1 }, $push: { rows: { label: 'New' } } },
  ])
    assert.throws(() => encodeUpdate(fields, update, now), /conflicting/);
  for (const operator of ['$unset', '$inc']) {
    for (const path of ['typo', 'rows.0.label', 'rows.$.label', 'rows.$[row].label']) {
      assert.throws(() => encodeUpdate(fields, { [operator]: { [path]: 1 } }, now));
    }
    assert.throws(() => encodeUpdate(fields, { [operator]: {} }, now), /Empty/);
    assert.throws(() => encodeUpdate(fields, { [operator]: [] }, now));
  }
});
