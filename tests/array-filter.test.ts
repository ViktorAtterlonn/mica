import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BSON } from 'mongodb';
import { prepareArrayFilters } from '../src/update.js';
import { array, arrayFilter, customType, number, object, string } from '../src/index.js';

test('typed array filters prefix logical predicates and snapshot caller values', () => {
  const rows = array(object({ name: string(), score: number() }));
  const input = { $or: [{ name: 'one' }, { score: { $gte: 3 } }] };
  const filter = arrayFilter('row', rows, input);
  input.$or[0]!.name = 'changed';
  assert.deepEqual(BSON.deserialize(BSON.serialize(filter)), {
    $or: [{ 'row.name': 'one' }, { 'row.score': { $gte: 3 } }],
  });
  assert.deepEqual(
    BSON.deserialize(BSON.serialize(arrayFilter('score', array(number()), { $gte: 1 }))),
    {
      score: { $gte: 1 },
    },
  );
  assert.throws(() => arrayFilter('bad-id', rows, {}), /identifier/);
  const secret = customType({
    base: string,
    codec: {
      encode: (v: string) => v,
      decode: (v: string) => v,
      storedSchema: { bsonType: 'string' },
    },
  });
  assert.throws(
    () => arrayFilter('row', array(object({ token: secret() })), { token: 'plain' }),
    /codec/,
  );
});

test('array-filter helper predicates remain valid when checked again at the write boundary', () => {
  const rows = array(object({ tags: array(string()), score: number() }));
  const filter = arrayFilter('row', rows, { tags: { $size: 1 }, score: { $type: 16 } });
  assert.doesNotThrow(() =>
    prepareArrayFilters({ rows }, { $inc: { 'rows.$[row].score': 1 } }, [filter]),
  );
});
