import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import {
  array,
  collection,
  customType,
  object,
  objectId,
  string,
  timestamps,
} from '../src/index.js';
import { encodeDocument } from '../src/codec.js';
import { encodeUpdate } from '../src/update.js';
import { readProjection } from '../src/projection.js';

const Fields = collection('field_options', {
  _id: objectId().auto(),
  title: string(),
  secret: string(),
  profile: object({ name: string(), secret: string(), fixed: string().immutable() }),
  fixed: object({ value: string() }).immutable(),
  rows: array(object({ fixed: string().immutable(), secret: string() })),
  lockedRows: array(string()).immutable(),
  matrix: array(array(object({ secret: string(), fixed: string().immutable() }))),
  ...timestamps(),
});

test('field modifiers preserve flags through builder chains and custom bases without mutation', () => {
  const base = string();
  const fixedField = base.immutable();
  const wrapped = customType({ base: () => fixedField, metadata: { purpose: 'test' } })();
  for (const field of [
    fixedField.optional().nullable().default('x').min(1).max(9).pattern(/x/),
    wrapped,
  ]) {
    assert.equal(field.definition.immutable, true);
  }
  assert.equal(base.definition.immutable, undefined);
  assert.equal('select' in base, false);
});

test('read projections preserve explicit fields without adding schema defaults', () => {
  for (const projection of [
    {},
    { title: 0 },
    { profile: 0 },
    { profile: 1 },
    { secret: 1, _id: 0 },
    { _id: 1 },
    { _id: 0 },
    { title: 0, _id: 1 },
    { 'profile.secret': 1 },
  ]) {
    const input = Object.freeze(projection);
    const result = readProjection(Fields.$fields, input);
    assert.deepEqual(result, input);
    assert.notEqual(result, input);
  }
  assert.deepEqual(readProjection(Fields.$fields, undefined), {});
  assert.throws(() => readProjection(Fields.$fields, { secret: 1, title: 0 }), /mix/);
  assert.throws(
    () => readProjection(Fields.$fields, { profile: 1, 'profile.secret': 1 }),
    /conflicting/,
  );
});

test('immutable paths, ancestors and replacement descendants reject before encoding', () => {
  const now = new Date();
  const input = {
    title: 'title',
    secret: 'secret',
    profile: { name: 'name', secret: 'secret', fixed: 'id' },
    fixed: { value: 'fixed' },
    rows: [],
    lockedRows: [],
    matrix: [],
  };
  const encoded = encodeDocument(Fields.$fields, input, now);
  assert(encoded._id instanceof ObjectId);
  assert.equal(encoded.secret, 'secret');
  for (const update of [
    { $set: { 'profile.fixed': 'new' } },
    { $set: { 'fixed.value': 'new' } },
    { $set: { fixed: { value: 'new' } } },
    { $set: { profile: { name: 'new', secret: 'new', fixed: 'id' } } },
    { $set: { rows: [] } },
    { $set: { matrix: [] } },
    { $push: { lockedRows: 'new' } },
    { $push: { lockedRows: { $each: ['new'] } } },
    { $set: { createdAt: now } },
  ])
    assert.throws(() => encodeUpdate(Fields.$fields, update, now), /immutable/);
  assert.deepEqual(
    encodeUpdate(
      Fields.$fields,
      {
        $set: { 'profile.name': 'changed', secret: 'rotated' },
        $push: { rows: { $each: [{ fixed: 'new', secret: 'new' }] } },
      },
      now,
    ),
    {
      $set: { 'profile.name': 'changed', secret: 'rotated', updatedAt: now },
      $push: { rows: { $each: [{ fixed: 'new', secret: 'new' }] } },
    },
  );
  const deep = {
    a: object({
      b: object({ c: object({ d: object({ e: object({ f: string().immutable() }) }) }) }),
    }),
  };
  assert.throws(() => encodeUpdate(deep, { $set: { a: {} } }, now), /immutable/);
});
