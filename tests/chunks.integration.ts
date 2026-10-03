import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MongoClient, ObjectId, type Document } from 'mongodb';
import {
  collection,
  createDatabase,
  customType,
  jsonSchema,
  object,
  objectId,
  string,
} from '../packages/db/src/index.js';

const uri = process.env.MICA_TEST_URI;
if (!uri) throw new Error('Use pnpm run test:integration for an isolated MongoDB container');
const id = (value: number) => new ObjectId(value.toString(16).padStart(24, '0'));

async function collect<T>(chunks: AsyncIterable<T[]>) {
  const batches: T[][] = [];
  for await (const batch of chunks) batches.push(batch);
  return batches;
}

test('find arrays, explicit cursors, and projected _id chunks', async (t) => {
  let decodes = 0;
  const secret = customType({
    base: string,
    codec: {
      encode: (value: string) => `stored:${value}`,
      decode: (value: string) => {
        decodes++;
        if (value === 'broken') throw new Error('broken token');
        return value.slice(7);
      },
      storedSchema: { bsonType: 'string' },
    },
  });
  const Rows = collection('rows', {
    _id: objectId().auto(),
    name: string(),
    group: string(),
    token: secret(),
    profile: object({ label: string(), token: secret() }),
  });
  const client = new MongoClient(uri, { monitorCommands: true });
  const commands: { name: string; command: Document }[] = [];
  client.on('commandStarted', (e) => commands.push({ name: e.commandName, command: e.command }));
  const db = createDatabase({
    client,
    database: 'mica_chunks',
    collections: { rows: Rows },
  });
  t.after(() => db.close());
  await db.connect();
  const raw = await client
    .db('mica_chunks')
    .createCollection('rows', { validator: jsonSchema(Rows) });
  await db.rows.insertMany(
    Array.from({ length: 7 }, (_, n) => ({
      _id: id(n + 1),
      name: `row-${n + 1}`,
      group: 'scan',
      token: `token-${n + 1}`,
      profile: { label: `profile-${n + 1}`, token: `nested-${n + 1}` },
    })),
  );

  await t.test(
    'find returns a real promise of projected arrays and cursor streams explicitly',
    async () => {
      decodes = 0;
      const promise = db.rows.find(
        { group: 'scan' },
        { sort: { _id: -1 }, skip: 1, limit: 2, projection: { name: 1, token: 1, _id: 0 } },
      );
      assert(promise instanceof Promise);
      const values = await promise;
      assert.deepEqual(values, [
        { name: 'row-6', token: 'token-6' },
        { name: 'row-5', token: 'token-5' },
      ]);
      assert.equal(await promise, values);
      assert.equal(decodes, 2);
      assert.deepEqual(await db.rows.find({ name: 'absent' }), []);
      const count = commands.length;
      const cursor = db.rows
        .cursor({ group: 'scan' }, { projection: { name: 1, _id: 0 } })
        .sort({ _id: 1 })
        .limit(1);
      assert.equal(commands.length, count);
      assert.deepEqual(await cursor.toArray(), [{ name: 'row-1' }]);
      assert(cursor.closed);
      await assert.rejects(db.rows.find({ token: 'plaintext' }), /codec-backed/);
      await assert.rejects(db.rows.find({}, { sort: { token: 1 } }), /codec-backed/);
    },
  );

  await t.test(
    'chunks are lazy bounded pages, return all fields, and issue no count or skip',
    async () => {
      decodes = 0;
      const before = commands.length;
      const chunks = db.rows.chunks({ group: 'scan' }, { size: 3 });
      assert.equal(commands.length, before);
      const batches = await collect(chunks);
      assert.deepEqual(
        batches.map((x) => x.length),
        [3, 3, 1],
      );
      assert.deepEqual(
        batches.flat().map((x) => x.name),
        Array.from({ length: 7 }, (_, n) => `row-${n + 1}`),
      );
      for (const row of batches.flat()) {
        assert(row._id instanceof ObjectId);
        assert.equal(row.token, row.name.replace('row-', 'token-'));
        assert.equal(row.profile.token, row.name.replace('row-', 'nested-'));
      }
      assert.equal(decodes, 14);
      const pageCommands = commands.slice(before);
      assert(!pageCommands.some((e) => e.name === 'aggregate' || e.name === 'count'));
      const finds = pageCommands.filter((e) => e.name === 'find');
      assert.equal(finds.length, 3);
      for (const { command } of finds) {
        assert.deepEqual(command.sort, new Map([['_id', 1]]));
        assert.equal(command.limit, 3);
        assert.equal(command.skip, undefined);
        assert.deepEqual(command.projection, {});
      }
      assert(finds[1]!.command.filter.$and[1]._id.$gt.equals(id(3)));
    },
  );

  await t.test(
    'inclusion and exclusion projections match find, including _id:0 and codecs',
    async () => {
      // Dynamic projection cases exercise runtime parity; literal inference is tested separately.
      for (const projection of [
        { name: 1, _id: 0 },
        { name: 1, _id: 1 },
        { token: 1, _id: 0 },
        { profile: 1 },
        { group: 0, _id: 0 },
        { _id: 0 },
        { _id: 1 },
        {},
        { name: 0, _id: 1 },
      ] as const) {
        const expected = await db.rows.find(
          { group: 'scan' },
          { projection: projection as never, sort: { _id: 1 } },
        );
        const actual = (
          await collect(
            db.rows.chunks({ group: 'scan' }, { size: 2, projection: projection as never }),
          )
        ).flat();
        assert.deepEqual(actual, expected);
      }
      const values = (
        await collect(
          db.rows.chunks({ group: 'scan' }, { size: 2, projection: { name: 1, _id: 0 } }),
        )
      ).flat();
      assert(values.every((row) => !('_id' in row)));
      const ordinary = (await collect(db.rows.chunks({ group: 'scan' }, { size: 2 }))).flat();
      assert(ordinary.every((row) => row._id instanceof ObjectId));
    },
  );

  await t.test('continuation intersects existing ID filters and supports resume', async () => {
    const range = (
      await collect(
        db.rows.chunks(
          { _id: { $gte: id(2), $lte: id(6) } },
          { size: 2, afterId: id(3), projection: { name: 1 } },
        ),
      )
    ).flat();
    assert.deepEqual(
      range.map((row) => row.name),
      ['row-4', 'row-5', 'row-6'],
    );
    const exact = (
      await collect(
        db.rows.chunks({ _id: id(4) }, { size: 1, afterId: id(2), projection: { name: 1 } }),
      )
    ).flat();
    assert.deepEqual(exact, [{ _id: id(4), name: 'row-4' }]);
    assert.deepEqual(
      await collect(db.rows.chunks({ _id: id(2) }, { size: 1, afterId: id(2) })),
      [],
    );
    const selected = (
      await collect(
        db.rows.chunks(
          { _id: { $in: [id(1), id(3), id(7)] }, $or: [{ name: 'row-3' }, { name: 'row-7' }] },
          { size: 1, projection: { name: 1 } },
        ),
      )
    ).flat();
    assert.deepEqual(
      selected.map((row) => row.name),
      ['row-3', 'row-7'],
    );
  });

  await t.test('checkpoints survive mutations of arguments and yielded IDs/arrays', async () => {
    const filter = { group: 'scan' };
    const afterId = id(1);
    const projection = { name: 1 as const, _id: 1 as const };
    const options = { size: 2, afterId, projection };
    const chunks = db.rows.chunks(filter, options);
    filter.group = 'mutated';
    afterId.id.fill(255);
    options.size = 100;
    const first = await chunks.next();
    assert(!first.done);
    assert.deepEqual(
      first.value.map((row) => row.name),
      ['row-2', 'row-3'],
    );
    first.value[1]!._id.id.fill(255);
    first.value.length = 0;
    const second = await chunks.next();
    assert(!second.done);
    assert.deepEqual(
      second.value.map((row) => row.name),
      ['row-4', 'row-5'],
    );
    await chunks.return();
  });

  await t.test(
    'early break stops requests, no empty batches, and mutations of processed rows do not skip items',
    async () => {
      const before = commands.length;
      for await (const batch of db.rows.chunks({ group: 'scan' }, { size: 2 })) {
        assert.equal(batch.length, 2);
        break;
      }
      assert.equal(commands.slice(before).filter((e) => e.name === 'find').length, 1);
      assert.deepEqual(await collect(db.rows.chunks({ name: 'absent' }, { size: 2 })), []);
      const exact = await collect(db.rows.chunks({ _id: { $lte: id(6) } }, { size: 3 }));
      assert.deepEqual(
        exact.map((x) => x.length),
        [3, 3],
      );
      const seen: string[] = [];
      for await (const batch of db.rows.chunks(
        { group: 'scan' },
        { size: 2, projection: { name: 1, _id: 1 } },
      )) {
        seen.push(...batch.map((row) => row.name));
        await db.rows.updateMany(
          { _id: { $in: batch.map((row) => row._id) } },
          { $set: { group: 'processed' } },
        );
      }
      assert.equal(new Set(seen).size, 7);
      await db.rows.updateMany({}, { $set: { group: 'scan' } });
    },
  );

  await t.test('chunk validation rejects invalid options before any query', async () => {
    const before = commands.length;
    for (const options of [
      {},
      { size: 0 },
      { size: -1 },
      { size: 1.5 },
      { size: Infinity },
      { size: 1, afterId: 'bad' },
      { size: 1, sort: { name: 1 } },
      { size: 1, skip: 1 },
      { size: 1, limit: 1 },
      { size: 1, projection: { name: 1, token: 0 } },
      { size: 1, projection: { typo: 1 } },
    ]) {
      assert.throws(() => db.rows.chunks({}, options as never));
    }
    assert.throws(() => db.rows.chunks({ token: 'plaintext' }, { size: 1 }), /codec-backed/);
    assert.equal(commands.length, before);
  });

  await t.test('decode failure and malformed legacy IDs terminate iteration', async () => {
    await raw.updateOne({ _id: id(2) }, { $set: { token: 'broken' } });
    const chunks = db.rows.chunks({}, { size: 1, projection: { token: 1 } });
    assert.equal((await chunks.next()).done, false);
    await assert.rejects(chunks.next(), /broken token/);
    const before = commands.length;
    assert.equal((await chunks.next()).done, true);
    assert.equal(commands.length, before);
    await raw.updateOne({ _id: id(2) }, { $set: { token: 'stored:token-2' } });
    await raw.insertOne({ _id: 'legacy-id', name: 'malformed' } as never, {
      bypassDocumentValidation: true,
    });
    await assert.rejects(db.rows.chunks({}, { size: 10 }).next(), /ObjectId/);
    await raw.deleteOne({ _id: 'legacy-id' } as never);
  });
});
