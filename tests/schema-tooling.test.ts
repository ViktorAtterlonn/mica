import assert from 'node:assert/strict';
import test from 'node:test';
import { BSON } from 'mongodb';
import { collection, jsonSchema } from '../packages/db/src/schema.js';
import { string, number } from '../packages/db/src/fields.js';
import { index } from '../packages/db/src/indexes.js';
import {
  normalizeDeclarations,
  normalizeIndex,
  normalizeValidator,
  validatorDocument,
  indexDocument,
} from '../packages/db/src/schema-normalize.js';
import {
  compareSchemas,
  emptyValidator,
  valueDifferences,
} from '../packages/db/src/schema-diff.js';
import { renderDiff } from '../packages/cli/src/render.js';
import { applySchemaDiff } from '../packages/db/src/schema-push.js';
import type { DatabaseSchema } from '../packages/db/src/schema-model.js';
import type { Db } from 'mongodb';

const Records = collection(
  'records',
  { _id: string(), name: string(), count: number().optional() },
  (t) => [index('mica_name').on(t.name)],
);
const desired = () => normalizeDeclarations({ Records });
const actual = () => structuredClone(desired());
const kinds = (db: DatabaseSchema) => compareSchemas(desired(), db).changes.map((c) => c.kind);

test('normalizes schema ordering, defaults, required sets, enum sets and BSON types', () => {
  const a = {
    $jsonSchema: {
      bsonType: 'object',
      properties: { x: { bsonType: ['string'], enum: ['b', 'a'] }, y: { bsonType: 'number' } },
      required: ['x', 'y'],
      additionalProperties: true,
    },
  };
  const b = {
    $jsonSchema: {
      required: ['y', 'x'],
      properties: { y: { bsonType: 'number' }, x: { enum: ['a', 'b'], bsonType: 'string' } },
      bsonType: ['object'],
    },
  };
  assert.deepEqual(normalizeValidator(a), normalizeValidator(b, 'strict', 'error'));
  assert.deepEqual(normalizeValidator({}), normalizeValidator({}, 'off', 'warn'));
  const schema = jsonSchema(Records);
  assert.deepEqual(
    normalizeValidator(validatorDocument(normalizeValidator(schema).validator)),
    normalizeValidator(schema),
  );
});

test('normalizes logical schema branch ordering but preserves oneOf multiplicity', () => {
  const a = { bsonType: 'string' },
    b = { bsonType: 'null' };
  assert.deepEqual(
    normalizeValidator({ $jsonSchema: { anyOf: [a, b, a] } }),
    normalizeValidator({ $jsonSchema: { anyOf: [b, a] } }),
  );
  assert.notDeepEqual(
    normalizeValidator({ $jsonSchema: { oneOf: [a, a] } }),
    normalizeValidator({ $jsonSchema: { oneOf: [a] } }),
  );
});

test('schema property names matching keywords are restored without interpretation', () => {
  const raw = {
    $jsonSchema: { properties: { enum: { enum: ['hi'] }, properties: { bsonType: 'string' } } },
  };
  assert.deepEqual(validatorDocument(normalizeValidator(raw).validator), raw);
});

test('indexes normalize defaults, key maps, logical filters, equality shorthand and in sets', () => {
  const a = normalizeIndex({
    name: 'name',
    key: { name: 1, count: -1 },
    partialFilterExpression: { name: 'hello', count: { $in: [3, 1, 3] } },
  });
  const b = normalizeIndex({
    name: 'name',
    key: new Map([
      ['name', 1],
      ['count', -1],
    ]),
    unique: false,
    sparse: false,
    v: 2,
    background: true,
    partialFilterExpression: { $and: [{ count: { $in: [1, 3] } }, { name: { $eq: 'hello' } }] },
  });
  assert.deepEqual(a, b);
  assert.deepEqual(normalizeIndex(indexDocument(a)), a);
  assert.notDeepEqual(
    a,
    normalizeIndex({
      name: 'name',
      key: { count: -1, name: 1 },
      partialFilterExpression: { name: 'hello', count: { $in: [1, 3] } },
    }),
  );
});

test('BSON filter literals survive round trips and preserve document and array order', () => {
  for (const value of [
    new BSON.ObjectId(),
    new Date('2025-01-01'),
    new BSON.Binary(Buffer.from('hi')),
    { a: 1, b: 2 },
    ['a', 'b'],
  ]) {
    const normalized = normalizeIndex({
      name: 'name',
      key: { name: 1 },
      partialFilterExpression: { value },
    });
    assert.deepEqual(normalizeIndex(indexDocument(normalized)), normalized);
  }
  const normalize = (value: unknown) =>
    normalizeIndex({ name: 'name', key: { name: 1 }, partialFilterExpression: { value } });
  assert.notDeepEqual(normalize({ a: 1, b: 2 }), normalize({ b: 2, a: 1 }));
  assert.notDeepEqual(normalize([1, 2]), normalize([2, 1]));
});

test('unsupported validator and index features remain explicit with source evidence', () => {
  for (const raw of [
    { $expr: { $eq: ['$x', '$y'] } },
    { $jsonSchema: { mystery: { a: 1 } } },
    { $jsonSchema: {}, other: true },
  ])
    assert.ok(normalizeValidator(raw).issues.length);
  for (const spec of [
    { collation: { locale: 'en' } },
    { hidden: true },
    { storageEngine: { unknown: true } },
    { key: { name: 'text' } },
    { key: { '$**': 1 } },
    { partialFilterExpression: { name: { $regex: 'x' } } },
    { partialFilterExpression: { name: /x/ } },
    { name: '*' },
    { key: { '2': 1, '1': -1 } },
  ]) {
    const result = normalizeIndex({ name: 'name', key: { name: 1 }, ...spec });
    assert.ok(result.issues.length, JSON.stringify(spec));
    assert.ok(result.issues[0]!.source);
  }
});

test('diff covers validator added, removed, changed and enforcement settings', () => {
  assert.deepEqual(kinds(actual()), []);
  const absent = actual();
  absent.collections[0]!.validator = emptyValidator();
  assert.deepEqual(kinds(absent), ['validator-added']);
  assert.deepEqual(
    compareSchemas(absent, desired()).changes.map((c) => c.kind),
    ['validator-removed'],
  );
  const changed = actual();
  changed.collections[0]!.validator.level = 'moderate';
  assert.deepEqual(kinds(changed), ['validator-changed']);
  const diff = compareSchemas(desired(), changed);
  const change = diff.changes[0]!;
  assert.ok(change.kind === 'validator-changed');
  assert.deepEqual(change.details, [{ path: ['level'], before: 'moderate', after: 'strict' }]);
});

test('diff covers missing collections and index additions, owned removals, changes', () => {
  assert.deepEqual(kinds({ collections: [] }), [
    'collection-added',
    'validator-added',
    'index-added',
  ]);
  const missing = actual();
  missing.collections[0]!.indexes = [];
  assert.deepEqual(kinds(missing), ['index-added']);
  const extra = actual();
  extra.collections[0]!.indexes.push(normalizeIndex({ name: 'mica_old', key: { count: 1 } }));
  assert.deepEqual(kinds(extra), ['index-removed']);
  const changed = actual();
  changed.collections[0]!.indexes[0]!.unique = true;
  assert.deepEqual(kinds(changed), ['index-changed']);
  extra.collections[0]!.indexes[1]!.name = 'other_service';
  const diff = compareSchemas(desired(), extra);
  assert.equal(diff.changes.length, 0);
  assert.equal(diff.unmanagedIndexes[0]!.index.name, 'other_service');
});

test('unsupported definitions block writes even for unrelated supported changes', async () => {
  const db = actual();
  db.collections[0]!.indexes[0] = normalizeIndex({
    name: 'mica_name',
    key: { name: 1 },
    hidden: true,
  });
  db.collections[0]!.validator = emptyValidator();
  const diff = compareSchemas(desired(), db);
  assert.deepEqual(
    diff.changes.map((c) => c.kind),
    ['unsupported', 'validator-added'],
  );
  await assert.rejects(applySchemaDiff({} as Db, diff), /Unsupported configuration/);
  diff.changes.shift();
  await assert.rejects(applySchemaDiff({} as Db, diff), /plan does not match/);
});

test('diff and output are deterministic, structured and retain both sides', () => {
  const db = actual();
  db.collections[0]!.indexes = [];
  const diff = compareSchemas(desired(), db);
  assert.deepEqual(JSON.parse(JSON.stringify(diff)), diff);
  assert.equal(renderDiff(diff, 'diff'), renderDiff(compareSchemas(desired(), db), 'diff'));
  assert.match(renderDiff(diff, 'diff'), /\+ create index mica_name/);
  assert.doesNotMatch(renderDiff(diff, 'check'), /keys/);
});

test('declarations require an explicit registry with unique collection names', () => {
  assert.throws(() => normalizeDeclarations({}), /nonempty/);
  assert.throws(() => normalizeDeclarations({ Records, duplicate: Records }), /duplicate/);
  assert.throws(() => normalizeDeclarations({ invalid: {} } as never), /declarations/);
});

test('validator enum BSON literals retain exact types and precision when deployed', () => {
  const value = BSON.Long.fromString('9223372036854775807');
  const normalized = normalizeValidator({ $jsonSchema: { enum: [value] } });
  const restored = validatorDocument(normalized.validator);
  assert.equal(restored.$jsonSchema.enum[0].toString(), value.toString());
  assert.deepEqual(normalizeValidator(restored), normalized);
});

test('validator path details distinguish own properties from prototype names', () => {
  const after = { properties: { constructor: { bsonType: 'string' } } };
  assert.deepEqual(valueDifferences({ properties: {} }, after), [
    { path: ['properties', 'constructor'], after: { bsonType: 'string' } },
  ]);
});
