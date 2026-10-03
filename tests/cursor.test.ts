import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Document, FindCursor } from 'mongodb';
import { collection, createDatabase, customType, objectId, string } from '../src/index.js';
import { DecodingCursor } from '../src/cursor.js';

function stub(next: () => Promise<Document | null>, close: () => Promise<void>) {
  // Only the native consumption boundary is mocked; the wrapper runs unchanged.
  return { closed: false, next, close } as unknown as FindCursor<Document>;
}

test('cursor rejects overlapping consumers and keeps the first read usable', async () => {
  let resolve!: (value: Document | null) => void;
  const pending = new Promise<Document | null>((yes) => {
    resolve = yes;
  });
  let calls = 0;
  const cursor = new DecodingCursor(
    stub(
      () => {
        calls++;
        return pending;
      },
      async () => {},
    ),
    { name: string() },
    () => {},
  );
  const first = cursor.next();
  await assert.rejects(cursor.next(), /active consumer/);
  await assert.rejects(cursor.toArray(), /active consumer/);
  assert.equal(calls, 1);
  resolve({ name: 'one' });
  assert.deepEqual(await first, { name: 'one' });
  await cursor.close();
  assert.equal(await cursor.next(), null);
});

test('cursor closes on readiness or decode failure without masking the original error', async () => {
  let reads = 0;
  let closes = 0;
  const native = () =>
    stub(
      async () => {
        reads++;
        return { secret: 'stored' };
      },
      async () => {
        closes++;
        throw new Error('cleanup failed');
      },
    );
  const disconnected = new DecodingCursor(native(), {}, () => {
    throw new Error('not connected');
  });
  await assert.rejects(disconnected.next(), /not connected/);
  assert.equal(reads, 0);
  assert.equal(closes, 1);
  assert(disconnected.closed);

  const secret = customType({
    base: string,
    codec: {
      encode: (v: string) => v,
      decode: (_v: string): string => {
        throw new Error('decoding failed');
      },
      storedSchema: { bsonType: 'string' },
    },
  });
  const broken = new DecodingCursor(native(), { secret: secret() }, () => {});
  await assert.rejects(broken.toArray(), /decoding failed/);
  assert.equal(reads, 1);
  assert.equal(closes, 2);
  assert(broken.closed);
  const iterated = new DecodingCursor(native(), { secret: secret() }, () => {});
  await assert.rejects(iterated[Symbol.asyncIterator]().next(), /decoding failed/);
  assert(iterated.closed);
});

test('all collection operations require an explicit connection', async () => {
  const Records = collection('records', { _id: objectId().auto(), name: string() });
  const db = createDatabase({
    uri: 'mongodb://127.0.0.1:1',
    database: 'unused',
    collections: { records: Records },
  });
  assert.throws(() => db.records.cursor(), /connect/);
  assert.throws(() => db.records.chunks({}, { size: 2 }), /connect/);
  const operations = [
    () => db.records.find(),
    () => db.records.findOne(),
    () => db.records.exists(),
    () => db.records.countDocuments(),
    () => db.records.distinct('name'),
    () => db.records.insertOne({ name: 'x' }),
    () => db.records.insertMany([{ name: 'x' }]),
    () => db.records.updateOne({}, { $set: { name: 'x' } }),
    () => db.records.updateMany({}, { $set: { name: 'x' } }),
    () => db.records.deleteOne({}),
    () => db.records.deleteMany({}),
    () => db.records.findOneAndUpdate({}, { $set: { name: 'x' } }),
    () => db.records.findOneAndDelete({}),
    () => db.records.bulkWrite([{ insertOne: { document: { name: 'x' } } }]),
  ];
  for (const operation of operations) await assert.rejects(operation(), /connect/);
  await db.close();
  assert.throws(() => db.records.cursor(), /connect/);
  assert.throws(() => db.records.chunks({}, { size: 2 }), /connect/);
});
