import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MongoClient, type Db } from 'mongodb';
import { collection } from '../packages/db/src/schema.js';
import { string, number, date } from '../packages/db/src/fields.js';
import { index } from '../packages/db/src/indexes.js';
import { normalizeDeclarations } from '../packages/db/src/schema-normalize.js';
import { introspectDatabase } from '../packages/db/src/schema-introspect.js';
import { compareSchemas } from '../packages/db/src/schema-diff.js';
import { applySchemaDiff } from '../packages/db/src/schema-push.js';
import { runCli } from '../packages/cli/src/commands.js';
import type { CliIO } from '../packages/cli/src/terminal.js';

const uri = process.env.MICA_TEST_URI;
if (!uri) throw new Error('Run through the disposable integration runner');
const Records = collection(
  'records',
  { _id: string(), name: string(), count: number().optional() },
  (t) => [index('mica_name').on(t.name).unique()],
);
const desired = normalizeDeclarations({ Records });
const plan = async (db: Db) => compareSchemas(desired, await introspectDatabase(db, ['records']));

async function database(work: (db: Db) => Promise<void>): Promise<void> {
  const client = new MongoClient(uri!);
  await client.connect();
  const db = client.db(`mica_tooling_${randomUUID().replaceAll('-', '')}`);
  try {
    await work(db);
  } finally {
    await db.dropDatabase();
    await client.close();
  }
}

async function fixture(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mica-cli-'));
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  await writeFile(
    join(dir, 'mica.config.ts'),
    `import { defineConfig } from ${JSON.stringify(new URL('../packages/cli/src/index.ts', import.meta.url).href)}; export default defineConfig({ schema: './schema.ts', database: { uri: ${JSON.stringify(uri)}, name: ${JSON.stringify(name)} } });`,
  );
  await writeFile(
    join(dir, 'schema.ts'),
    `import { collection } from ${JSON.stringify(new URL('../packages/db/src/schema.ts', import.meta.url).href)}; import { string } from ${JSON.stringify(new URL('../packages/db/src/fields.ts', import.meta.url).href)}; import { index } from ${JSON.stringify(new URL('../packages/db/src/indexes.ts', import.meta.url).href)}; export default { records: collection('records', { _id: string(), name: string() }, t => [index('mica_name').on(t.name).unique()]) };`,
  );
  return dir;
}

function capture(confirm?: () => Promise<boolean>) {
  const output: string[] = [],
    errors: string[] = [],
    progress: (string | undefined)[] = [];
  const io: CliIO = {
    out: (s) => output.push(s),
    error: (s) => errors.push(s),
    interactive: !!confirm,
    progress: (message) => progress.push(message),
    ...(confirm ? { confirm } : {}),
  };
  return { output, errors, progress, io };
}

test('real metadata diff → push → check; _id ignored and unrelated collections untouched', async () => {
  await database(async (db) => {
    await db.createCollection('other_service', { validator: { external: { $exists: true } } });
    await db.collection('other_service').createIndex({ external: 1 }, { name: 'external' });
    const unrelated = await db.listCollections({ name: 'other_service' }).toArray();
    const before = await plan(db);
    assert.deepEqual(
      before.changes.map((c) => c.kind),
      ['collection-added', 'validator-added', 'index-added'],
    );
    assert.equal(
      await db
        .collection('records')
        .estimatedDocumentCount()
        .catch(() => 0),
      0,
    );
    assert.equal((await db.listCollections({ name: 'records' }).toArray()).length, 0);
    const after = await applySchemaDiff(db, before);
    assert.deepEqual(after.changes, []);
    assert.deepEqual(
      after.actual.collections[0]!.indexes.map((i) => i.name),
      ['mica_name'],
    );
    assert.deepEqual(await db.listCollections({ name: 'other_service' }).toArray(), unrelated);
    assert.equal((await db.collection('other_service').listIndexes().toArray()).length, 2);
    await assert.rejects(
      db.collection('records').insertOne({ _id: 'one', name: 42 } as never),
      /validation/i,
    );
  });
});

test('existing validator updates, enforcement drift and supported index replacement/removal', async () => {
  await database(async (db) => {
    await applySchemaDiff(db, await plan(db));
    await db.command({
      collMod: 'records',
      validator: { $jsonSchema: { bsonType: 'object' } },
      validationLevel: 'moderate',
      validationAction: 'warn',
    });
    await db.collection('records').dropIndex('mica_name');
    await db.collection('records').createIndex({ name: 1 }, { name: 'mica_name' });
    await db.collection('records').createIndex({ count: 1 }, { name: 'mica_old' });
    await db.collection('records').createIndex({ count: -1 }, { name: 'external' });
    const diff = await plan(db);
    assert.deepEqual(
      diff.changes.map((c) => c.kind),
      ['validator-changed', 'index-removed', 'index-changed'],
    );
    assert.equal(diff.unmanagedIndexes[0]!.index.name, 'external');
    assert.deepEqual((await applySchemaDiff(db, diff)).changes, []);
    assert.ok(
      (await db.collection('records').listIndexes().toArray()).some((i) => i.name === 'external'),
    );
  });
});

test('owned index renames drop before creating an equivalent index', async () => {
  await database(async (db) => {
    await db.createCollection('records');
    await db.collection('records').createIndex({ name: 1 }, { name: 'mica_z_old', unique: true });
    assert.deepEqual((await applySchemaDiff(db, await plan(db))).changes, []);
  });
});

test('unsupported validators, indexes, views and collection collation block all writes', async () => {
  await database(async (db) => {
    for (const setup of [
      async () => {
        await db.createCollection('records', { validator: { name: { $exists: true } } });
      },
      async () => {
        await db.createCollection('records');
        await db
          .collection('records')
          .createIndex({ name: 1 }, { name: 'mica_name', hidden: true });
      },
      async () => {
        await db.createCollection('records', { collation: { locale: 'en' } });
      },
      async () => {
        await db.createCollection('records', { viewOn: 'source', pipeline: [] });
      },
    ]) {
      await setup();
      const before = await introspectDatabase(db, ['records']);
      const diff = compareSchemas(desired, before);
      assert.ok(diff.changes.some((c) => c.kind === 'unsupported'));
      await assert.rejects(applySchemaDiff(db, diff), /Unsupported configuration/);
      assert.deepEqual(await introspectDatabase(db, ['records']), before);
      await db.collection('records').drop();
    }
  });
});

test('unique-index failures preserve native error details and do not transform duplicates', async () => {
  await database(async (db) => {
    await db.collection('records').insertMany([
      { _id: 'a', name: 'duplicate' },
      { _id: 'b', name: 'duplicate' },
    ] as never);
    await assert.rejects(
      applySchemaDiff(db, await plan(db)),
      /records.mica_name: index-added failed:.*E11000/s,
    );
    assert.equal(await db.collection('records').countDocuments({ name: 'duplicate' }), 2);
    assert.ok((await plan(db)).changes.some((c) => c.kind === 'index-added'));
  });
});

test('metadata changes after planning abort before applying a stale plan', async () => {
  await database(async (db) => {
    const diff = await plan(db);
    await db.createCollection('records');
    await assert.rejects(applySchemaDiff(db, diff), /metadata changed/);
    assert.deepEqual(
      (await introspectDatabase(db, ['records'])).collections[0]!.validator.schema,
      null,
    );
  });
});

test('partial, sparse, compound and TTL indexes round-trip against MongoDB', async () => {
  await database(async (db) => {
    const Entries = collection(
      'entries',
      { _id: string(), name: string(), count: number(), expires: date() },
      (t) => [
        index('mica_compound')
          .on(t.name, t.count.desc())
          .partial({ name: 'active', count: { $in: [1, 2] } }),
        index('mica_sparse').on(t.count).sparse(),
        index('mica_ttl').on(t.expires).expireAfterSeconds(300),
      ],
    );
    const target = normalizeDeclarations({ Entries });
    const diff = compareSchemas(target, await introspectDatabase(db, ['entries']));
    assert.ok(diff.changes.some((c) => c.risks.includes('ttl-deletion')));
    assert.deepEqual((await applySchemaDiff(db, diff)).changes, []);
  });
});

test('CLI check/diff are read-only; confirmation defaults no; --yes and JSON share engine', async () => {
  await database(async (db) => {
    const dir = await fixture(db.databaseName);
    try {
      const captured = capture();
      assert.equal(await runCli(['check'], captured.io, dir), 1);
      assert.equal(
        captured.output.at(-1),
        'Schema drift detected: 3 differences. Run mica diff for details.',
      );
      assert.equal(await runCli(['diff'], captured.io, dir), 0);
      const human = captured.output.at(-1);
      assert.match(human!, /create missing collection/);
      assert.match(human!, /create index mica_name/);
      assert.match(human!, /database\s+null/);
      assert.equal(await runCli(['diff'], captured.io, dir), 0);
      assert.equal(captured.output.at(-1), human);
      assert.equal(await runCli(['push'], captured.io, dir), 1);
      assert.match(captured.errors.at(-1)!, /confirmation or --yes/);
      assert.equal(await runCli(['push'], capture(async () => false).io, dir), 1);
      assert.equal((await db.listCollections().toArray()).length, 0);
      const unattended = capture(async () => {
        throw new Error('--yes must never prompt');
      });
      assert.equal(await runCli(['push', '--yes'], unattended.io, dir), 0);
      assert.deepEqual(unattended.progress, []);
      assert.equal(await runCli(['check', '--json'], captured.io, dir), 0);
      const json = JSON.parse(captured.output.at(-1)!);
      assert.deepEqual(json.changes, []);
      assert.equal(json.version, 1);
      assert.deepEqual(captured.progress, []);
      await db.command({ collMod: 'records', validator: {} });
      const interactive = capture(async () => {
        assert.match(interactive.output.at(-1)!, /add validator/);
        assert.equal(
          (await introspectDatabase(db, ['records'])).collections[0]!.validator.schema,
          null,
        );
        return true;
      });
      assert.equal(await runCli(['push'], interactive.io, dir), 0);
      assert.deepEqual(interactive.progress, [
        'Inspecting database schema',
        undefined,
        'Applying schema changes',
        undefined,
      ]);
      interactive.progress.length = 0;
      assert.equal(await runCli(['check'], interactive.io, dir), 0);
      assert.equal(interactive.output.at(-1), 'Schema is synchronized.');
      assert.equal(await runCli(['diff', '--json'], interactive.io, dir), 0);
      assert.deepEqual(JSON.parse(interactive.output.at(-1)!).changes, []);
      assert.deepEqual(interactive.progress, []);
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)),
          fileURLToPath(new URL('../packages/cli/src/bin.ts', import.meta.url)),
          'check',
        ],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout, 'Schema is synchronized.\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('CLI reports blocked push and failed index operations with distinct exit codes', async () => {
  await database(async (db) => {
    const dir = await fixture(db.databaseName);
    try {
      await db.createCollection('records', { validator: { name: { $exists: true } } });
      const captured = capture();
      assert.equal(await runCli(['check'], captured.io, dir), 1);
      assert.equal(await runCli(['push', '--yes'], captured.io, dir), 1);
      await db.command({ collMod: 'records', validator: {} });
      await db.collection('records').insertMany([
        { _id: 'a', name: 'same' },
        { _id: 'b', name: 'same' },
      ] as never);
      assert.equal(await runCli(['push', '--yes'], captured.io, dir), 2);
      assert.match(captured.errors.at(-1)!, /E11000/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('failed validator operations expose native errors without changing documents', async () => {
  await database(async (db) => {
    await applySchemaDiff(db, await plan(db));
    const invalid = structuredClone(desired);
    invalid.collections[0]!.validator.schema!.maxLength = -1;
    const diff = compareSchemas(invalid, await introspectDatabase(db, ['records']));
    await assert.rejects(
      applySchemaDiff(db, diff),
      /records: validator-changed failed:.*maxLength/s,
    );
    assert.deepEqual((await plan(db)).changes, []);
  });
});

test('validator removal is supported by the shared engine without dropping collections', async () => {
  await database(async (db) => {
    await applySchemaDiff(db, await plan(db));
    const without = structuredClone(desired);
    without.collections[0]!.validator.schema = null;
    const diff = compareSchemas(without, await introspectDatabase(db, ['records']));
    assert.deepEqual(
      diff.changes.map((c) => c.kind),
      ['validator-removed'],
    );
    assert.deepEqual((await applySchemaDiff(db, diff)).changes, []);
    assert.equal((await db.listCollections({ name: 'records' }).toArray()).length, 1);
  });
});
