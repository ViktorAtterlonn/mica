import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Binary, MongoClient, ObjectId, type Document } from 'mongodb';
import {
  array,
  binary,
  boolean,
  collection,
  createDatabase,
  customType,
  date,
  enum_,
  jsonSchema,
  map,
  MicaValidationError,
  number,
  object,
  objectId,
  string,
  type AnyField,
} from '../packages/db/src/index.js';

const uri = process.env.MICA_TEST_URI;
if (!uri) throw new Error('Use pnpm run test:integration for an isolated MongoDB container');

const kinds = ['text', 'number', 'boolean', 'date', 'objectId', 'binary', 'enum', 'codec'] as const;
const layouts = ['scalar', 'object', 'array', 'map'] as const;
type Kind = (typeof kinds)[number];
const cases = kinds.length * layouts.length * 2;
const seed = Number(process.env.MICA_GENERATED_SEED ?? 0x51ca2026);
const selectedCase =
  process.env.MICA_GENERATED_CASE === undefined
    ? undefined
    : Number(process.env.MICA_GENERATED_CASE);
if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
  throw new Error('MICA_GENERATED_SEED must be a uint32');
if (
  selectedCase !== undefined &&
  (!Number.isInteger(selectedCase) || selectedCase < 0 || selectedCase >= cases)
)
  throw new Error(`MICA_GENERATED_CASE must be in 0..${cases - 1}`);

function random(caseId: number) {
  let state = (seed ^ Math.imul(caseId + 1, 2654435761)) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

// The reference documents and updates below are constructed explicitly. They do
// not import Mica's encoder, decoder, projection builder, or runtime schema walkers.
function sample(kind: Kind, next: () => number): unknown {
  const value = next();
  switch (kind) {
    case 'text':
    case 'codec':
      return ['plain', 'é😀', '東京', '$literal'][value % 4]! + (value % 100);
    case 'number':
      return ((value % 101) - 50) / 4;
    case 'boolean':
      return value % 2 === 0;
    case 'date':
      return new Date(Date.UTC(2025, 0, 1) + value);
    case 'objectId':
      return new ObjectId(value.toString(16).padStart(24, '0'));
    case 'binary':
      return new Binary(Buffer.from([value % 256, (value >>> 8) % 256]));
    case 'enum':
      return value % 2 ? 'open' : 'done';
  }
}

const encoded = customType({
  base: string,
  codec: {
    encode: (value: string) => new Binary(Buffer.from(`wire:${value}`, 'utf8')),
    decode: (value: Binary) => Buffer.from(value.value()).toString('utf8').slice(5),
    storedSchema: { bsonType: 'binData' },
  },
});

function leaf(kind: Kind, optional: boolean): AnyField {
  const field =
    kind === 'text'
      ? string().min(1).max(24).default('fallback')
      : kind === 'codec'
        ? encoded().min(1).max(24).default('fallback')
        : kind === 'number'
          ? number().min(-100).max(100).default(0)
          : kind === 'boolean'
            ? boolean().default(false)
            : kind === 'date'
              ? date().default(new Date(0))
              : kind === 'objectId'
                ? objectId().default(new ObjectId('000000000000000000000001'))
                : kind === 'binary'
                  ? binary().default(new Binary(Buffer.from([0])))
                  : enum_('open', 'done').default('open');
  return optional ? field.nullable().optional() : field;
}

function fallback(kind: Kind): unknown {
  switch (kind) {
    case 'text':
    case 'codec':
      return 'fallback';
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'date':
      return new Date(0);
    case 'objectId':
      return new ObjectId('000000000000000000000001');
    case 'binary':
      return new Binary(Buffer.from([0]));
    case 'enum':
      return 'open';
  }
}

function stored(kind: Kind, value: unknown): unknown {
  return kind === 'codec' && value !== null
    ? new Binary(Buffer.concat([Buffer.from('wire:'), Buffer.from(value as string)]))
    : value;
}

test('generated schema, projection and write contracts agree with independent native collections', async (t) => {
  const native = new MongoClient(uri);
  await native.connect();
  t.after(() => native.close());
  const database = 'mica_generated_contracts';
  t.diagnostic(
    `Replay: MICA_GENERATED_SEED=${seed} MICA_GENERATED_CASE=<case> pnpm run test:generated`,
  );

  for (let caseId = 0; caseId < cases; caseId++) {
    if (selectedCase !== undefined && caseId !== selectedCase) continue;
    const kind = kinds[Math.floor(caseId / 8)]!;
    const layout = layouts[Math.floor(caseId / 2) % 4]!;
    const optional = caseId % 2 === 1;
    await t.test(
      `seed=${seed} case=${caseId} ${kind}/${layout}/${optional ? 'nullable' : 'required'}`,
      async () => {
        const next = random(caseId);
        const note = string().default('note');
        const valueField = leaf(kind, optional && layout !== 'map');
        const payload =
          layout === 'scalar'
            ? valueField
            : layout === 'object'
              ? object({ value: valueField, note }).nullable().optional()
              : layout === 'array'
                ? array(object({ value: valueField, note }).nullable())
                : map(leaf(kind, false));
        const Schema = collection(`actual_${caseId}`, {
          _id: string(),
          group: enum_('a', 'b'),
          score: number().integer().min(-1000).max(1000).default(0),
          owner: objectId(),
          secret: encoded(),
          tags: array(string()),
          payload,
        });
        const db = createDatabase({ uri: uri!, database, collections: { records: Schema } });
        await db.connect();
        try {
          await native
            .db(database)
            .createCollection(Schema.$name, { validator: jsonSchema(Schema) });
          const actual = native.db(database).collection(Schema.$name);
          const storage = native.db(database).collection(`storage_${caseId}`);
          const application = native.db(database).collection(`application_${caseId}`);
          const inputs: Document[] = [];
          const expectedApp: Document[] = [];
          const expectedStorage: Document[] = [];

          for (let row = 0; row < 5; row++) {
            const value = optional && row === 1 ? null : sample(kind, next);
            const omit = row === 2;
            const resolved = omit ? fallback(kind) : value;
            const inputBase = {
              _id: `row_${row}`,
              group: row % 2 ? 'a' : 'b',
              owner: new ObjectId(next().toString(16).padStart(24, '0')),
              secret: `secret_${row}`,
              tags: ['initial'],
            };
            const appBase = { ...inputBase, score: 0 };
            const storedBase = {
              ...appBase,
              secret: new Binary(Buffer.from(`wire:secret_${row}`)),
            };
            let inputPayload: unknown, appPayload: unknown, storedPayload: unknown;
            if (layout === 'scalar') {
              inputPayload = value;
              appPayload = resolved;
              storedPayload = stored(kind, resolved);
            } else if (layout === 'object') {
              inputPayload = omit ? {} : { value };
              appPayload = { value: resolved, note: 'note' };
              storedPayload = { value: stored(kind, resolved), note: 'note' };
              if (row === 3) inputPayload = appPayload = storedPayload = null;
            } else if (layout === 'array') {
              inputPayload = [omit ? {} : { value }, null];
              appPayload = [{ value: resolved, note: 'note' }, null];
              storedPayload = [{ value: stored(kind, resolved), note: 'note' }, null];
              if (row === 3) inputPayload = appPayload = storedPayload = [];
            } else {
              const mapValue = value ?? sample(kind, next);
              inputPayload = { one: mapValue };
              appPayload = { one: mapValue };
              storedPayload = { one: stored(kind, mapValue) };
              if (row === 3) inputPayload = appPayload = storedPayload = {};
            }
            inputs.push({
              ...inputBase,
              ...(layout === 'scalar' && omit ? {} : { payload: inputPayload }),
            });
            expectedApp.push({ ...appBase, payload: appPayload });
            expectedStorage.push({ ...storedBase, payload: storedPayload });
          }
          await db.records.insertMany(inputs as never);
          await storage.insertMany(expectedStorage);
          await application.insertMany(expectedApp);
          const compareStorage = async () =>
            assert.deepEqual(
              await actual.find().sort({ _id: 1 }).toArray(),
              await storage.find().sort({ _id: 1 }).toArray(),
            );
          await compareStorage();

          const projections: (Document | undefined)[] = [
            undefined,
            {},
            { _id: 1 },
            { _id: 0 },
            { payload: 1, _id: 0 },
            { secret: 1 },
            { tags: 0, _id: 1 },
          ];
          if (layout === 'object' || layout === 'array')
            projections.push({ 'payload.value': 1, _id: 0 });
          for (const request of projections) {
            const options = {
              ...(request ? { projection: request } : {}),
              sort: { _id: 1 as const },
            };
            const expected = await application
              .find({}, { projection: request ?? {}, sort: { _id: 1 } })
              .toArray();
            assert.deepEqual(await db.records.find({}, options as never), expected);
            assert.deepEqual(await db.records.cursor({}, options as never).toArray(), expected);
            assert.deepEqual(await db.records.findOne({}, options as never), expected[0]);
            const chunks: Document[] = [];
            for await (const batch of db.records.chunks({}, {
              size: 2,
              ...(request ? { projection: request } : {}),
            } as never))
              chunks.push(...batch);
            assert.deepEqual(chunks, expected);
            const pipeline = db.records.aggregate().sort({ _id: 1 });
            // Runtime-generated projections exercise validation/results. Literal type
            // inference is covered separately by the compile-only fixtures.
            const project = pipeline.project as unknown as (value: Document) => {
              toArray(): Promise<Document[]>;
            };
            const projected = request ? project.call(pipeline, request) : pipeline;
            assert.deepEqual(
              await projected.toArray(),
              await application
                .aggregate([
                  { $sort: { _id: 1 } },
                  ...(request && Object.keys(request).length ? [{ $project: request }] : []),
                ])
                .toArray(),
            );
          }

          for (let step = 0; step < 6; step++) {
            const id = `row_${next() % 5}`;
            const delta = (next() % 9) - 4;
            const secret = `rotated_${next()}`;
            const update =
              step % 2 === 0
                ? { $inc: { score: delta }, $set: { secret } }
                : { $push: { tags: `tag_${next()}` } };
            const storedUpdate =
              step % 2 === 0
                ? {
                    $inc: { score: delta },
                    $set: { secret: new Binary(Buffer.from(`wire:${secret}`)) },
                  }
                : update;
            const result = await db.records.updateOne({ _id: id }, update as never);
            const reference = await storage.updateOne(
              { _id: id } as never,
              storedUpdate as Document,
            );
            await application.updateOne({ _id: id } as never, update as Document);
            assert.equal(result.matchedCount, reference.matchedCount);
            assert.equal(result.modifiedCount, reference.modifiedCount);
            await compareStorage();
          }
          const changed = sample(kind, next);
          const path =
            layout === 'scalar'
              ? 'payload'
              : layout === 'array'
                ? 'payload.0.value'
                : layout === 'object'
                  ? 'payload.value'
                  : 'payload.one';
          const returned = await db.records.findOneAndUpdate(
            { _id: 'row_0' },
            { $set: { [path]: changed } } as never,
            { returnDocument: 'after', projection: { payload: 1, _id: 0 } },
          );
          await storage.updateOne({ _id: 'row_0' } as never, {
            $set: { [path]: stored(kind, changed) },
          });
          const expectedReturned = await application.findOneAndUpdate(
            { _id: 'row_0' } as never,
            { $set: { [path]: changed } },
            { returnDocument: 'after', projection: { payload: 1, _id: 0 } },
          );
          assert.deepEqual(returned, expectedReturned);
          await compareStorage();

          await db.records.bulkWrite([
            { updateOne: { filter: { _id: 'row_0' }, update: { $inc: { score: 1 } } } },
            { deleteOne: { filter: { _id: 'row_4' } } },
          ]);
          for (const reference of [storage, application]) {
            await reference.bulkWrite([
              { updateOne: { filter: { _id: 'row_0' } as never, update: { $inc: { score: 1 } } } },
              { deleteOne: { filter: { _id: 'row_4' } as never } },
            ]);
          }
          await compareStorage();
          const rawPipeline = [
            { $group: { _id: '$group', total: { $sum: '$score' }, count: { $sum: 1 } } },
            { $sort: { _id: 1 } },
          ];
          assert.deepEqual(
            await db.records
              .aggregate()
              .group({ _id: '$group', total: { $sum: '$score' }, count: { $sum: 1 } })
              .sort({ _id: 1 })
              .toArray(),
            await storage.aggregate(rawPipeline).toArray(),
          );
          const target = expectedApp[next() % expectedApp.length]!;
          assert.deepEqual(
            await db.records
              .aggregate()
              .match({ owner: target.owner.toHexString() })
              .project({ owner: 1, _id: 0 })
              .toArray(),
            await application
              .find({ owner: target.owner }, { projection: { owner: 1, _id: 0 } })
              .toArray(),
          );
        } finally {
          await db.close();
        }
      },
    );
  }
});

test('invalid filters and sparse writes issue no database command', async (t) => {
  const Schema = collection('guarded', { _id: string(), name: string(), values: array(string()) });
  const client = new MongoClient(uri, { monitorCommands: true });
  const db = createDatabase({
    client,
    database: 'mica_contract_preflight',
    collections: { records: Schema },
  });
  t.after(() => db.close());
  await db.connect();
  await db.records.insertOne({ _id: 'keep', name: 'one', values: [] });
  let commands = 0;
  client.on('commandStarted', ({ commandName }) => {
    if (['find', 'aggregate', 'update', 'delete', 'insert', 'distinct'].includes(commandName))
      commands++;
  });
  const invalid = { name: undefined } as never;
  const sparse: string[] = [];
  sparse.length = 1;
  for (const operation of [
    () => db.records.find(invalid),
    () => db.records.findOne(invalid),
    () => db.records.exists(invalid),
    () => db.records.countDocuments(invalid),
    () => db.records.distinct('name', invalid),
    () => db.records.deleteOne(invalid),
    () => db.records.deleteMany(invalid),
    () => db.records.updateOne(invalid, { $set: { name: 'changed' } }),
    () => db.records.updateMany(invalid, { $set: { name: 'changed' } }),
    () => db.records.findOneAndUpdate(invalid, { $set: { name: 'changed' } }),
    () => db.records.findOneAndDelete(invalid),
    () => db.records.bulkWrite([{ deleteMany: { filter: invalid } }]),
    () => db.records.insertOne({ _id: 'sparse', name: 'bad', values: sparse }),
    () => db.records.updateOne({}, { $push: { values: { $each: sparse } } }),
  ])
    await assert.rejects(operation(), MicaValidationError);
  assert.throws(() => db.records.aggregate().match(invalid), MicaValidationError);
  assert.throws(() => db.records.cursor(invalid), MicaValidationError);
  assert.throws(() => db.records.chunks(invalid, { size: 2 }), MicaValidationError);
  assert.equal(commands, 0);
  assert.deepEqual(await db.records.find(), [{ _id: 'keep', name: 'one', values: [] }]);
});
