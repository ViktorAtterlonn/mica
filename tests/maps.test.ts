import assert from 'node:assert/strict';
import { test } from 'node:test';
import { array, customType, map, number, object, string } from '../src/index.js';
import { checkFilter } from '../src/filter.js';
import { encodeDocument, decodeDocument } from '../src/codec.js';
import { encodeUpdate } from '../src/update.js';
import { readProjection } from '../src/projection.js';

const now = new Date();
test('maps validate dynamic keys, encode entries, and preserve defaults and decoding', () => {
  const secret = customType({
    base: string,
    codec: {
      encode: (v: string) => `stored:${v}`,
      decode: (v: string) => v.slice(7),
      storedSchema: { bsonType: 'string' },
    },
  });
  const fields = { sessions: map(object({ secret: secret(), count: number().default(0) })) };
  const stored = encodeDocument(fields, { sessions: { 'session-1': { secret: 'token' } } }, now);
  assert.deepEqual(stored, { sessions: { 'session-1': { secret: 'stored:token', count: 0 } } });
  assert.deepEqual(decodeDocument(fields, stored), {
    sessions: { 'session-1': { secret: 'token', count: 0 } },
  });
  assert.deepEqual(encodeUpdate(fields, { $set: { 'sessions.next': { secret: 'new' } } }, now), {
    $set: { 'sessions.next': { secret: 'stored:new', count: 0 } },
  });
  assert.deepEqual(encodeUpdate(fields, { $unset: { 'sessions.next': 1 } }, now), {
    $unset: { 'sessions.next': 1 },
  });
  assert.throws(
    () => checkFilter(fields, { 'sessions.next': { secret: 'token', count: 0 } }),
    /codec/,
  );
  assert.throws(
    () => encodeUpdate(fields, { $set: { 'sessions.next.secret': 'nested' } }, now),
    /atomic/,
  );
  for (const key of ['', 'bad.key', '$bad', '__proto__', 'constructor', 'prototype', 'bad\0key']) {
    assert.throws(
      () => encodeDocument(fields, { sessions: { [key]: { secret: 'x' } } }, now),
      /map key/,
    );
  }
  for (const key of ['0', 'x', 'session-1', 'é', '😀'])
    assert.doesNotThrow(() =>
      encodeDocument(fields, { sessions: { [key]: { secret: 'x' } } }, now),
    );
});

test('map definitions and updates preserve projection and immutable boundaries', () => {
  assert.throws(() => map(string().optional()), /optional/);
  const fields = {
    counts: map(number()),
    fixed: map(number().immutable()),
    hidden: map(string()),
  };
  assert.deepEqual(
    encodeUpdate(fields, { $inc: { 'counts.a': 1 }, $unset: { 'counts.b': 1 } }, now),
    { $inc: { 'counts.a': 1 }, $unset: { 'counts.b': 1 } },
  );
  assert.throws(() => encodeUpdate(fields, { $set: { 'fixed.a': 1 } }, now), /immutable/);
  assert.throws(() => encodeUpdate(fields, { $set: { fixed: {} } }, now), /immutable/);
  assert.deepEqual(readProjection(fields, undefined), {});
  assert.deepEqual(readProjection(fields, { 'hidden.a': 1 }), { 'hidden.a': 1 });
  assert.throws(() => encodeUpdate(fields, { $push: { counts: 1 } }, now), /array/);
  assert.throws(() => checkFilter(fields, { counts: { $size: 1 } }), /array/);
  assert.throws(
    () => checkFilter({ labels: map(string()) }, { labels: { $regex: 'x' } }),
    /string field/,
  );
  assert.doesNotThrow(() =>
    encodeDocument({ entries: array(map(number())) }, { entries: [{ a: 1 }] }, now),
  );
});

test('scalar membership operators reject arrays of maps', () => {
  const fields = { entries: array(map(number())) };
  for (const operator of ['$addToSet', '$pull'])
    assert.throws(() => encodeUpdate(fields, { [operator]: { entries: { a: 1 } } }, now), /scalar/);
});
