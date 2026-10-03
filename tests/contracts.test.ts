import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import {
  array,
  arrayFilter,
  collection,
  customType,
  MicaValidationError,
  index,
  number,
  object,
  objectId,
  string,
} from '../packages/db/src/index.js';
import { checkFilter } from '../packages/db/src/filter.js';
import { encodeDocument } from '../packages/db/src/codec.js';
import { encodeUpdate } from '../packages/db/src/update.js';
import { prepareFilter } from '../packages/db/src/query-options.js';

test('filter values cannot silently disappear or become null during BSON serialization', () => {
  const fields = { name: string(), rows: array(object({ name: string() })) };
  const sparse: string[] = [];
  sparse.length = 1;
  for (const filter of [
    { name: undefined },
    { name: { $eq: undefined } },
    { name: { $in: [undefined] } },
    { name: { $in: sparse } },
    { $or: [{ name: undefined }, { name: 'one' }] },
    { rows: [{ name: undefined }] },
    { rows: { $elemMatch: { name: undefined } } },
  ])
    assert.throws(() => prepareFilter(fields, filter), MicaValidationError);
  assert.throws(
    () => arrayFilter('row', fields.rows, { name: undefined } as never),
    MicaValidationError,
  );
  assert.throws(
    () => encodeUpdate({ values: array(string()) }, { $pull: { values: undefined } }, new Date()),
    MicaValidationError,
  );
  assert.doesNotThrow(() => checkFilter(fields, { name: null }));
  const id = new ObjectId();
  assert.deepEqual(prepareFilter({ name: string() }, { name: { $in: ['one', 'two'] } }), {
    name: { $in: ['one', 'two'] },
  });
  assert.deepEqual(prepareFilter({ id: objectId() }, { id }), { id });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => checkFilter(fields, { name: cycle }), MicaValidationError);
});

test('sparse arrays cannot bypass insertion or update element validation', () => {
  const fields = { values: array(string()) };
  const sparse: string[] = [];
  sparse.length = 2;
  sparse[1] = 'present';
  assert.throws(() => encodeDocument(fields, { values: sparse }, new Date()), MicaValidationError);
  assert.throws(
    () => encodeUpdate(fields, { $push: { values: { $each: sparse } } }, new Date()),
    MicaValidationError,
  );
  assert.throws(
    () => encodeUpdate(fields, { $addToSet: { values: { $each: sparse } } }, new Date()),
    MicaValidationError,
  );
  const permissive = customType({
    validate: (_value: unknown): _value is unknown => true,
    storedSchema: {},
  });
  assert.throws(
    () => encodeDocument({ values: array(permissive()) }, { values: sparse }, new Date()),
    MicaValidationError,
  );
});

test('schema length bounds and field names can be represented by a MongoDB validator', () => {
  for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => string().min(invalid));
    assert.throws(() => string().max(invalid));
    assert.throws(() => array(string()).min(invalid));
    assert.throws(() => array(string()).max(invalid));
  }
  assert.doesNotThrow(() => number().min(-1.5).max(2.5));
  assert.doesNotThrow(() => string().min(0).max(2));
  assert.throws(() => object({ ['bad\0name']: string() }));
  assert.throws(() => collection('bad', { _id: string(), ['bad\0name']: string() }));
});

test('partial index predicates cannot serialize sparse operands as null', () => {
  const sparse: string[] = [];
  sparse.length = 1;
  assert.throws(() =>
    collection('partial', { _id: string(), name: string() }, (fields) => [
      index('by_name')
        .on(fields.name)
        .partial({ name: { $in: sparse } }),
    ]),
  );
});
