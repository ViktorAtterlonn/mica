import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BSON, ObjectId } from 'mongodb';
import {
  array,
  customType,
  map,
  MicaValidationError,
  number,
  object,
  objectId,
  string,
} from '../src/index.js';
import { prepareAggregateFilter } from '../src/aggregate-filter.js';

const id = new ObjectId();
const hex = id.toHexString();
const fields = {
  id: objectId(),
  label: string(),
  ids: array(objectId()),
  profile: object({ owner: objectId(), label: string() }),
  rows: array(object({ owner: objectId() })),
  links: map(objectId()),
};

test('aggregation casts ObjectId filter operands by schema, including nested predicates and literals', () => {
  const input = {
    $and: [{ id: hex.toUpperCase() }, { id: { $in: [hex, id] } }],
    $or: [{ 'profile.owner': hex }, { 'rows.owner': { $ne: hex } }],
    $nor: [{ id: { $not: { $nin: [hex] } } }],
    ids: { $all: [hex], $elemMatch: { $eq: hex } },
    rows: { $elemMatch: { owner: { $gte: hex, $lte: hex } } },
    'links.owner': hex,
    profile: { owner: hex, label: hex },
    label: hex,
  };
  const result = prepareAggregateFilter(fields, input);
  assert.deepEqual(result.$and, [{ id }, { id: { $in: [id, id] } }]);
  assert.deepEqual(result.$or, [{ 'profile.owner': id }, { 'rows.owner': { $ne: id } }]);
  assert.deepEqual(result.$nor, [{ id: { $not: { $nin: [id] } } }]);
  assert.deepEqual(result.ids, { $all: [id], $elemMatch: { $eq: id } });
  assert.deepEqual(result.rows, { $elemMatch: { owner: { $gte: id, $lte: id } } });
  assert.deepEqual(result['links.owner'], id);
  assert.deepEqual(result.profile, { owner: id, label: hex });
  assert.equal(result.label, hex);
  assert.equal(input.$and[0]!.id, hex.toUpperCase(), 'does not mutate caller input');
  assert.deepEqual(
    prepareAggregateFilter(fields, { ids: [hex], rows: [{ owner: hex }], links: { owner: hex } }),
    {
      ids: [id],
      rows: [{ owner: id }],
      links: { owner: id },
    },
  );
  assert.deepEqual(prepareAggregateFilter(fields, { ids: hex }), { ids: id });
});

test('aggregation preserves structural operands, null, codecs and atomic custom values', () => {
  const structural = { id: { $exists: true, $type: 'objectId' }, ids: { $size: 1, $type: 7 } };
  const prepared = prepareAggregateFilter(fields, structural);
  assert.deepEqual(BSON.deserialize(BSON.serialize(prepared)), structural);
  assert.deepEqual(prepareAggregateFilter(fields, { id: null }), { id: null });
  const coded = customType({
    base: objectId,
    codec: {
      encode: (value: ObjectId) => value.toHexString(),
      decode: (value: string) => new ObjectId(value),
      storedSchema: { bsonType: 'string' },
    },
  });
  assert.throws(() => prepareAggregateFilter({ id: coded() }, { id: hex }), /codec/);
  const atomic = customType<{ id: string }>({
    validate: (value): value is { id: string } =>
      !!value && typeof value === 'object' && 'id' in value,
    storedSchema: { bsonType: 'object' },
  });
  assert.deepEqual(prepareAggregateFilter({ value: atomic() }, { value: { id: hex } }), {
    value: { id: hex },
  });
  assert.deepEqual(prepareAggregateFilter({ _id: string() }, { _id: hex }), { _id: hex });
  // This feature does not introduce number or date coercion.
  assert.deepEqual(prepareAggregateFilter({ value: number() }, { value: '123' }), { value: '123' });
});

test('invalid ObjectId strings reject with the field path before execution', () => {
  for (const value of [
    '',
    'not-an-id',
    'x'.repeat(24),
    'a'.repeat(23),
    'a'.repeat(25),
    ` ${hex}`,
  ]) {
    assert.throws(
      () => prepareAggregateFilter(fields, { id: value }),
      (error) =>
        error instanceof MicaValidationError &&
        error.code === 'invalid_value' &&
        error.path === 'id',
    );
  }
  assert.throws(
    () => prepareAggregateFilter(fields, { rows: { $elemMatch: { owner: 'bad' } } }),
    (error) => error instanceof MicaValidationError && error.path === 'rows.owner',
  );
  assert.throws(
    () => prepareAggregateFilter(fields, { id: { $in: ['bad'] } }),
    MicaValidationError,
  );
  assert.throws(() => prepareAggregateFilter(fields, { id: { $where: hex } }), /unsupported/);
});
