import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Binary, ObjectId } from 'mongodb';
import { Products } from '../examples/entities/products.js';
import { encrypted } from '../examples/fields/encrypted.js';
import {
  array,
  boolean,
  collection,
  customType,
  date,
  discoverMetadata,
  enum_,
  jsonSchema,
  number,
  object,
  objectId,
  string,
} from '../src/index.js';
import { checkFilter } from '../src/filter.js';
import { checkProjection } from '../src/projection.js';
import { decodeDocument, encodeDocument } from '../src/codec.js';
import { encodeUpdate } from '../src/update.js';

const now = new Date('2026-10-01T00:00:00Z');
const input = () => ({
  organizationId: new ObjectId(),
  title: 'Title',
  details: { label: 'Nested', secret: 'hidden' },
  variants: [{ sku: 'a', title: 'Variant', price: 12, secret: 'inside' }],
  secrets: ['first'],
  internalNotes: 'private',
});

test('encode/decode plain objects recursively, defaults, generated fields, and no mutation', () => {
  const original = input();
  const encoded = encodeDocument(Products.$fields, original, now);
  assert(encoded._id instanceof ObjectId);
  assert.equal(encoded.status, 'draft');
  assert.equal(encoded.details.count, 0);
  assert.deepEqual(encoded.createdAt, now);
  assert.deepEqual(encoded.updatedAt, now);
  assert(encoded.internalNotes instanceof Binary);
  assert(encoded.details.secret instanceof Binary);
  assert(encoded.variants[0].secret instanceof Binary);
  assert(encoded.secrets[0] instanceof Binary);
  assert.equal(original.internalNotes, 'private');
  assert(!('status' in original));
  assert(!('_id' in encoded.details));
  const decoded = decodeDocument(Products.$fields, encoded);
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
  assert.equal(Object.getPrototypeOf(decoded.details), Object.prototype);
  assert.equal(decoded.internalNotes, 'private');
  assert.equal(decoded.details.secret, 'hidden');
  assert.equal(decoded.variants[0].secret, 'inside');
  assert.deepEqual(decoded.secrets, ['first']);
  assert(!('save' in decoded));
});

test('immutable builders preserve capability, semantic metadata and references', () => {
  const base = string();
  const constrained = base.min(2).max(5).optional();
  assert.equal(base.definition.min, undefined);
  assert.equal(constrained.definition.min, 2);
  assert.deepEqual(
    discoverMetadata(Products, 'translatable').map((x) => x.path),
    ['title', 'details.label', 'variants[].title'],
  );
  assert.equal(Products.organizationId.definition.reference!().definition.kind, 'objectId');
  assert.equal(Products.internalNotes.definition.max, 5000);
});

test('application validation occurs before encoding; constraints, optional and nullable differ', () => {
  for (const patch of [
    { title: '' },
    { status: 'bad' },
    { title: null },
    { internalNotes: undefined },
    { internalNotes: new Binary() },
    { typo: 'unknown' },
  ]) {
    assert.throws(() => encodeDocument(Products.$fields, { ...input(), ...patch }, now));
  }
  const valid = encodeDocument(Products.$fields, { ...input(), description: null }, now);
  assert.equal(valid.description, null);
  assert.throws(() => encodeDocument({ n: number().integer() }, { n: 1.2 }, now), /integer/);
  assert.throws(() => encodeDocument({ s: string().pattern(/^ok$/) }, { s: 'no' }, now), /pattern/);
  assert.throws(() => string().pattern(/x/i), /flags/);
  assert.throws(() => encodeDocument({ d: date() }, { d: new Date('bad') }, now));
  assert.throws(() => encodeDocument({ n: number() }, { n: Infinity }, now));
  assert.doesNotThrow(() => encodeDocument({ s: string().max(1) }, { s: '😀' }, now));
});

test('nested $set, whole object replacement and $push/$each encode every custom value', () => {
  const update = encodeUpdate(
    Products.$fields,
    {
      $set: { 'details.secret': 'changed', internalNotes: 'new' },
      $push: {
        secrets: { $each: ['second', 'third'] },
        variants: { sku: 'b', title: 'Next', price: 3, secret: 'safe' },
      },
    },
    now,
  );
  assert(update.$set['details.secret'] instanceof Binary);
  assert(update.$set.internalNotes instanceof Binary);
  assert(update.$push.secrets.$each.every((v: unknown) => v instanceof Binary));
  assert(update.$push.variants.secret instanceof Binary);
  assert.deepEqual(update.$set.updatedAt, now);
  const replacement = encodeUpdate(
    Products.$fields,
    { $set: { details: { label: 'Replaced', secret: 'still safe' } } },
    now,
  );
  assert(replacement.$set.details.secret instanceof Binary);
  assert.equal(replacement.$set.details.count, 0);
});

test('unsupported write cases and path conflicts fail closed', () => {
  for (const update of [
    { $rename: { internalNotes: 'title' } },
    { $mul: { 'details.count': 2 } },
    [{ $set: { internalNotes: 'plain' } }],
    { title: 'replacement' },
    { $set: { 'variants.-1.secret': 'x' } },
    { $set: { 'variants.$bad.secret': 'x' } },
    { $set: { createdAt: now } },
    { $set: { _id: new ObjectId() } },
    { $set: { details: { label: 'a' }, 'details.secret': 'b' } },
    { $set: { secrets: [] }, $push: { secrets: 'a' } },
    { $push: { secrets: { $each: ['x'], $unknown: 2 } } },
    { $push: { title: 'x' } },
    { $set: { constructor: 'x' } },
    {},
    { $set: {} },
  ])
    assert.throws(() => encodeUpdate(Products.$fields, update, now));
});

test('codec filtering is rejected even through parent objects and logical branches', () => {
  for (const filter of [
    { internalNotes: 'private' },
    { internalNotes: { $eq: 'private' } },
    { details: { secret: 'x' } },
    { 'variants.secret': 'x' },
    { $or: [{ internalNotes: { $in: ['x'] } }] },
    { $expr: { $eq: ['$internalNotes', 'x'] } },
    { title: { $where: 'x' } },
    { typo: 1 },
  ])
    assert.throws(() => checkFilter(Products.$fields, filter));
  assert.doesNotThrow(() =>
    checkFilter(Products.$fields, {
      internalNotes: { $exists: true },
      'variants.price': { $gte: 10 },
    }),
  );
});

test('projected decode only visits returned fields and does not materialize missing defaults', () => {
  assert.deepEqual(decodeDocument(Products.$fields, { title: 'Selected' }), { title: 'Selected' });
  assert.deepEqual(decodeDocument(Products.$fields, { details: { label: 'Partial' } }), {
    details: { label: 'Partial' },
  });
  assert.throws(() => checkProjection(Products.$fields, { title: 1, status: 0 }), /mix/);
  assert.doesNotThrow(() => checkProjection(Products.$fields, { 'details.secret': 1 }));
  assert.throws(() => checkProjection(Products.$fields, { title: { $slice: 1 } }));
});

test('JSON Schema describes storage, including nullable codec and nested required fields', () => {
  const schema = jsonSchema(Products).$jsonSchema as any;
  assert.deepEqual(schema.properties.internalNotes, { bsonType: 'binData' });
  assert.deepEqual(schema.properties.details.properties.secret, { bsonType: 'binData' });
  assert.deepEqual(schema.properties.title, { bsonType: 'string', minLength: 1, maxLength: 200 });
  assert.deepEqual(schema.properties.variants.items.required, ['sku', 'title', 'price']);
  assert(schema.required.includes('status'));
  assert(schema.required.includes('createdAt'));
  assert(!schema.required.includes('internalNotes'));
  const Nullable = collection('nullable', {
    _id: objectId().auto(),
    secret: encrypted().nullable(),
    status: enum_('a', 'b').nullable(),
    active: boolean(),
  });
  const nullable = jsonSchema(Nullable).$jsonSchema as any;
  assert.deepEqual(nullable.properties.secret, {
    anyOf: [{ bsonType: 'binData' }, { bsonType: 'null' }],
  });
  assert.equal(nullable.properties.active.bsonType, 'bool');
  assert.equal(
    encodeDocument(Nullable.$fields, { secret: null, status: null, active: true }, now).secret,
    null,
  );
});

test('defaults create isolated embedded objects and reference functions are never invoked on writes', () => {
  const defaultObject = { label: 'Default' };
  const fields = {
    child: object({ label: string() }).default(defaultObject),
    reference: objectId().references(() => {
      throw new Error('must not execute');
    }),
  };
  const first = encodeDocument(fields, { reference: new ObjectId() }, now);
  first.child.label = 'Changed';
  assert.equal(encodeDocument(fields, { reference: new ObjectId() }, now).child.label, 'Default');
  assert.equal(defaultObject.label, 'Default');
});

test('codec errors propagate; deferred composite and stacked codecs are rejected', () => {
  const broken = customType({
    base: string,
    codec: {
      storedSchema: { bsonType: 'string' },
      encode() {
        throw new Error('encode failure');
      },
      decode() {
        throw new Error('decode failure');
      },
    },
  });
  assert.throws(() => encodeDocument({ secret: broken() }, { secret: 'x' }, now), /encode failure/);
  assert.throws(() => decodeDocument({ secret: broken() }, { secret: 'x' }), /decode failure/);
  assert.throws(
    () =>
      customType({
        base: () => object({ s: string() }),
        codec: { storedSchema: {}, encode: () => '', decode: () => ({ s: '' }) },
      })(),
    /Composite/,
  );
  assert.throws(() => array(string().optional()), /optional/);
  assert.throws(() => collection('bad', { _id: objectId().optional() }), /required/);
});
