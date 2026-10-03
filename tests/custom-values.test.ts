import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collection, customType, jsonSchema, string } from '../src/index.js';
import { decodeDocument, encodeDocument } from '../src/codec.js';

const settingValue = customType({
  validate: (value: unknown): value is string | number | boolean =>
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)),
  storedSchema: { bsonType: ['string', 'number', 'bool'] },
});

test('atomic custom values preserve closed unions, modifiers, and stored validation', () => {
  const Settings = collection('settings', {
    _id: string(),
    value: settingValue().nullable().optional(),
  });
  for (const value of ['text', 42, true, null]) {
    const stored = encodeDocument(Settings.$fields, { _id: 'one', value }, new Date());
    assert.deepEqual(decodeDocument(Settings.$fields, stored), { _id: 'one', value });
  }
  assert.deepEqual(encodeDocument(Settings.$fields, { _id: 'one' }, new Date()), { _id: 'one' });
  assert.throws(() => encodeDocument(Settings.$fields, { _id: 'one', value: {} }, new Date()));
  assert.throws(() => encodeDocument(Settings.$fields, { _id: 'one', value: NaN }, new Date()));
  assert.deepEqual((jsonSchema(Settings).$jsonSchema.properties as Record<string, unknown>).value, {
    anyOf: [{ bsonType: ['string', 'number', 'bool'] }, { bsonType: 'null' }],
  });
});
