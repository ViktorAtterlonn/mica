import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Binary, MongoClient, ObjectId } from 'mongodb';
import { Products } from '../examples/entities/products.js';
import { createDatabase, jsonSchema } from '../packages/db/src/index.js';

const uri = process.env.MICA_TEST_URI;
if (!uri) throw new Error('Use pnpm run test:integration to start an isolated MongoDB container');
async function eventually(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 45_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(50);
  }
}

test(
  'real MongoDB: codecs, validation, typed updates/projections, and SDAM recovery',
  { timeout: 120_000 },
  async (t) => {
    const events: string[] = [];
    const errors: Error[] = [];
    const client = new MongoClient(uri, {
      heartbeatFrequencyMS: 500,
      serverSelectionTimeoutMS: 3000,
      monitorCommands: true,
    });
    const commands: string[] = [];
    client.on('commandStarted', (event) => commands.push(event.commandName));
    const db = createDatabase({
      client,
      database: 'mica_phase0',
      collections: { products: Products },
      events: {
        connected: () => events.push('connected'),
        disconnected: () => events.push('disconnected'),
        reconnected: () => events.push('reconnected'),
        error: (error) => errors.push(error),
      },
    });
    t.after(async () => {
      await db.close();
    });
    assert.equal(db.status, 'idle');
    const first = db.connect();
    assert.equal(db.status, 'connecting');
    await Promise.all([first, db.connect()]);
    assert.equal(db.status, 'connected');
    assert.deepEqual(events, ['connected']);
    assert(commands.includes('ping'));
    const nativeDb = db.client.db('mica_phase0');
    const version = await nativeDb.admin().command({ buildInfo: 1 });
    t.diagnostic(`MongoDB ${version.version}; driver 7.7.0; Node ${process.version}`);
    await nativeDb.createCollection(Products.$name, { validator: jsonSchema(Products) });
    const raw = nativeDb.collection<typeof Products.$inferStored>(Products.$name);
    const input: typeof Products.$inferInsert = {
      organizationId: new ObjectId(),
      title: 'Original',
      details: { label: 'Nested', secret: 'nested secret' },
      variants: [{ sku: 'a', title: 'First', price: 5, secret: 'variant secret' }],
      secrets: ['one'],
      internalNotes: 'private notes',
    };
    const { insertedId } = await db.products.insertOne(input);
    const stored = await raw.findOne({ _id: insertedId });
    assert(stored);
    assert(stored.internalNotes instanceof Binary);
    assert(stored.details.secret instanceof Binary);
    assert(stored.variants[0]!.secret instanceof Binary);
    assert(stored.secrets[0] instanceof Binary);
    assert(!Buffer.from(stored.internalNotes.value()).includes(Buffer.from('private notes')));
    assert.equal(stored.status, 'draft');
    assert.equal(stored.details.count, 0);
    assert(stored.createdAt instanceof Date);
    assert(!('_id' in stored.variants[0]!));
    assert(!('_id' in input));
    const found = await db.products.findOne({ _id: insertedId, 'variants.price': { $lte: 10 } });
    assert(found);
    assert.equal(Object.getPrototypeOf(found), Object.prototype);
    assert.equal(found.internalNotes, 'private notes');
    assert.equal(found.details.secret, 'nested secret');
    assert.equal(found.variants[0]!.secret, 'variant secret');
    assert.deepEqual(found.secrets, ['one']);
    const result = await db.products.updateOne(
      { _id: insertedId },
      {
        $set: { title: 'Updated', 'details.secret': 'new nested secret' },
        $push: {
          secrets: { $each: ['two', 'three'] },
          variants: { sku: 'b', title: 'Second', price: 9, secret: 'second secret' },
        },
      },
    );
    assert.equal(result.matchedCount, 1);
    assert.equal(result.modifiedCount, 1);
    const updated = await db.products.findOne({ _id: insertedId });
    assert(updated);
    assert.equal(updated.title, 'Updated');
    assert.equal(updated.details.secret, 'new nested secret');
    assert.equal(updated.variants[1]!.secret, 'second secret');
    assert.deepEqual(updated.secrets, ['one', 'two', 'three']);
    assert.deepEqual(updated.createdAt, found.createdAt);
    assert(updated.updatedAt >= found.updatedAt);
    const updatedStorage = await raw.findOne({ _id: insertedId });
    assert(updatedStorage!.details.secret instanceof Binary);
    assert(updatedStorage!.variants[1]!.secret instanceof Binary);
    assert(updatedStorage!.secrets.every((value) => value instanceof Binary));
    assert.deepEqual(
      await db.products.findOne({ _id: insertedId }, { projection: { internalNotes: 1, _id: 0 } }),
      { internalNotes: 'private notes' },
    );
    const embedded = await db.products.findOne(
      { _id: insertedId },
      { projection: { details: 1, variants: 1 } },
    );
    assert(embedded);
    assert(embedded._id.equals(insertedId));
    assert.equal(embedded.details.secret, 'new nested secret');
    assert(!('title' in embedded));
    const excluded = await db.products.findOne(
      { _id: insertedId },
      { projection: { internalNotes: 0, _id: 1 } },
    );
    assert(excluded);
    assert(excluded._id.equals(insertedId));
    assert(!('internalNotes' in excluded));
    assert.deepEqual(
      Object.keys((await db.products.findOne({ _id: insertedId }, { projection: { _id: 1 } }))!),
      ['_id'],
    );
    assert.equal(
      (await db.products.findOne({ _id: insertedId }, { projection: {} }))!.title,
      'Updated',
    );
    assert.equal(await db.products.findOne({ _id: new ObjectId() }), null);

    // Raw bypass is deliberate. Server validator must reject plaintext even when the toolkit is bypassed.
    await assert.rejects(
      raw.updateOne({ _id: insertedId }, { $set: { internalNotes: 'plaintext' as never } }),
      (error: any) => error.code === 121,
    );
    await assert.rejects(
      raw.updateOne({ _id: insertedId }, { $set: { title: '' } }),
      (error: any) => error.code === 121,
    );
    const writeCommandsBefore = commands.filter((name) => name === 'update').length;
    await assert.rejects(
      db.products.updateOne({}, { $set: { internalNotes: 'secret' } }, { upsert: true } as never),
      /required field/,
    );
    await assert.rejects(
      db.products.updateOne({}, { $rename: { internalNotes: 'leak' } } as never),
      /unsupported/,
    );
    await assert.rejects(db.products.findOne({ internalNotes: 'private notes' }), /codec-backed/);
    await assert.rejects(
      db.products.findOne({}, { projection: { 'details.secret.part': 1 } } as never),
      /codec|path/,
    );
    assert.equal(commands.filter((name) => name === 'update').length, writeCommandsBefore);
    await db.products.updateOne(
      { _id: insertedId },
      { $set: { details: { label: 'Replacement', secret: 'safe replacement' } } },
    );
    assert.equal(
      (await db.products.findOne({ _id: insertedId }))!.details.secret,
      'safe replacement',
    );
    assert((await raw.findOne({ _id: insertedId }))!.details.secret instanceof Binary);

    // This container belongs to this test run and is removed by the runner.
    const container = process.env.MICA_TEST_CONTAINER!;
    execFileSync('docker', ['stop', '--time', '1', container], { stdio: 'pipe' });
    await eventually(() => db.status === 'disconnected', 'disconnected after server stop');
    await assert.rejects(db.products.findOne({}, { timeoutMS: 100 }), {
      name: 'MongoOperationTimeoutError',
    });
    execFileSync('docker', ['start', container], { stdio: 'pipe' });
    await eventually(() => db.status === 'connected', 'reconnected after server restart');
    assert.deepEqual(events, ['connected', 'disconnected', 'reconnected']);
    assert.equal((await db.products.findOne({ _id: insertedId }))!.title, 'Updated');
    await Promise.all([db.close(), db.close()]);
    assert.equal(db.status, 'closed');
    assert.deepEqual(events, ['connected', 'disconnected', 'reconnected', 'disconnected']);
    await assert.rejects(db.connect(), /closed/);
    assert.equal(client.listenerCount('topologyDescriptionChanged'), 0);
    t.diagnostic(
      `Lifecycle callbacks: ${events.join(' → ')}; reported probe errors: ${errors.length}`,
    );
  },
);
