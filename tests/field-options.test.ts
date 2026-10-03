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
  secret: string().select(false),
  profile: object({ name: string(), secret: string().select(false), fixed: string().immutable() }),
  fixed: object({ value: string() }).immutable(),
  rows: array(object({ fixed: string().immutable(), secret: string().select(false) })),
  lockedRows: array(string()).immutable(),
  matrix: array(array(object({ secret: string().select(false), fixed: string().immutable() }))),
  ...timestamps(),
});

test('field modifiers preserve flags through builder chains and custom bases without mutation', () => {
  const base = string();
  const privateField = base.select(false).immutable();
  const wrapped = customType({ base: () => privateField, metadata: { purpose: 'test' } })();
  for (const field of [
    privateField.optional().nullable().default('x').min(1).max(9).pattern(/x/),
    wrapped,
  ]) {
    assert.equal(field.definition.selected, false);
    assert.equal(field.definition.immutable, true);
  }
  assert.equal(base.definition.selected, undefined);
  assert.equal(base.definition.immutable, undefined);
  assert.equal(privateField.select(true).definition.selected, true);
  assert.equal(privateField.definition.selected, false);
  assert.throws(() => array(privateField), /array container/);
});

test('read projections omit hidden descendants and allow explicit whole-field selection', () => {
  const hidden = { secret: 0, 'profile.secret': 0, 'rows.secret': 0, 'matrix.secret': 0 };
  assert.deepEqual(readProjection(Fields.$fields, undefined), hidden);
  assert.deepEqual(readProjection(Fields.$fields, {}), hidden);
  assert.deepEqual(readProjection(Fields.$fields, { title: 0 }), { title: 0, ...hidden });
  assert.deepEqual(readProjection(Fields.$fields, { profile: 0 }), {
    profile: 0,
    secret: 0,
    'rows.secret': 0,
    'matrix.secret': 0,
  });
  assert.deepEqual(readProjection(Fields.$fields, { profile: 1 }), { profile: 1 });
  assert.deepEqual(readProjection(Fields.$fields, { secret: 1, _id: 0 }), { secret: 1, _id: 0 });
  assert.deepEqual(readProjection(Fields.$fields, { _id: 1 }), { _id: 1 });
  assert.deepEqual(readProjection(Fields.$fields, { _id: 0 }), { _id: 0, ...hidden });
  const input = Object.freeze({ title: 0, _id: 1 });
  assert.deepEqual(readProjection(Fields.$fields, input), { title: 0, ...hidden });
  assert.deepEqual(input, { title: 0, _id: 1 });
  assert.throws(() => readProjection(Fields.$fields, { secret: 1, title: 0 }), /mix/);
  assert.deepEqual(readProjection(Fields.$fields, { 'profile.secret': 1 }), {
    'profile.secret': 1,
  });
  assert.throws(
    () => readProjection(Fields.$fields, { profile: 1, 'profile.secret': 1 }),
    /conflicting/,
  );
});

test('hidden _id follows default selection while explicit _id overrides it', () => {
  const fields = {
    _id: objectId().auto().select(false),
    name: string(),
    secret: string().select(false),
  };
  assert.deepEqual(readProjection(fields, undefined), { _id: 0, secret: 0 });
  assert.deepEqual(readProjection(fields, { name: 1 }), { name: 1, _id: 0 });
  assert.deepEqual(readProjection(fields, { name: 1, _id: 1 }), { name: 1, _id: 1 });
  assert.deepEqual(readProjection(fields, { name: 0, _id: 1 }), { name: 0, secret: 0 });
  assert.deepEqual(readProjection(fields, { _id: 1 }), { _id: 1 });
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
