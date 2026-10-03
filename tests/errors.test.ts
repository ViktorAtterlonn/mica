import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Collection } from 'mongodb';
import {
  array,
  collection,
  customType,
  MicaValidationError,
  object,
  string,
} from '../src/index.js';
import { bindCollection } from '../src/collection.js';
import { encodeDocument } from '../src/codec.js';
import { encodeUpdate } from '../src/update.js';

const fields = {
  profile: object({ rows: array(object({ name: string() })) }),
  fixed: string().immutable(),
};

test('validation errors expose stable codes and complete nested field paths', () => {
  assert.throws(
    () => encodeDocument(fields, { profile: { rows: [{}] }, fixed: 'one' }, new Date()),
    (error) =>
      error instanceof MicaValidationError &&
      error.code === 'missing_field' &&
      error.path === 'profile.rows.0.name',
  );
  assert.throws(
    () => encodeUpdate(fields, { $set: { fixed: 'two' } }, new Date()),
    (error) =>
      error instanceof MicaValidationError &&
      error.code === 'immutable_field' &&
      error.path === 'fixed',
  );
});

test('driver and user codec failures retain their original identity', async () => {
  const failure = new Error('external failure');
  const native = {
    async insertOne() {
      throw failure;
    },
  } as unknown as Collection;
  const records = bindCollection(native, collection('errors', { _id: string() }), () => {});
  await assert.rejects(records.insertOne({ _id: 'one' }), (error) => error === failure);
  const broken = customType({
    base: string,
    codec: {
      encode: (_v: string): string => {
        throw failure;
      },
      decode: (v: string) => v,
      storedSchema: { bsonType: 'string' },
    },
  });
  assert.throws(
    () => encodeDocument({ value: broken() }, { value: 'one' }, new Date()),
    (error) => error === failure,
  );
  await assert.rejects(
    records.find({}, { limit: -1 }),
    (error) =>
      error instanceof MicaValidationError &&
      error.code === 'invalid_option' &&
      error.path === 'limit',
  );
});
