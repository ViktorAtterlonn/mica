import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packPackage } from './pack.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'mica-package-'));

try {
  const db = packPackage('db', temporary);
  const cliPackage = packPackage('cli', temporary);
  for (const packed of [db, cliPackage]) {
    assert(packed.files.includes('LICENSE'));
    assert(packed.files.includes('NOTICE'));
    assert(packed.files.includes('dist/index.js'));
    assert(packed.files.includes('dist/index.d.ts'));
    assert(
      packed.files.every(
        (file) =>
          file.startsWith('dist/') ||
          ['package.json', 'README.md', 'LICENSE', 'NOTICE'].includes(file),
      ),
      'Packages must contain only built code and publication metadata',
    );
    assert(
      !JSON.stringify(packed.manifest).includes('workspace:'),
      'Packed workspace ranges must be ordinary semver',
    );
  }
  assert.deepEqual(db.manifest.dependencies, { mongodb: '^7.7.0' });
  assert.equal(db.manifest.bin, undefined);
  assert.equal(db.manifest.exports['./cli'], undefined);
  assert(!db.files.some((file) => file.startsWith('dist/cli')));
  assert.equal(cliPackage.manifest.bin.mica, './dist/bin.js');
  assert.equal(cliPackage.manifest.peerDependencies['@mica/db'], `^${db.manifest.version}`);

  // Real npm consumers prove package isolation without workspace links or source imports.
  const consumer = {
    private: true,
    type: 'module',
    dependencies: { '@mica/db': `file:./${db.filename}` },
  };
  writeFileSync(join(temporary, 'package.json'), JSON.stringify(consumer));
  const install = (...args) =>
    execFileSync('npm', ['install', '--no-audit', '--no-fund', ...args], {
      cwd: temporary,
      stdio: 'pipe',
      timeout: 180_000,
    });
  install('--omit=dev');
  for (const name of ['tsx', 'esbuild', '@mica/cli'])
    assert(
      !existsSync(join(temporary, 'node_modules', name)),
      `${name} must not be installed with @mica/db`,
    );
  writeFileSync(
    join(temporary, 'db-only.mjs'),
    `
    import assert from 'node:assert/strict';
    import { collection, createDatabase, string } from '@mica/db';
    import { normalizeDeclarations } from '@mica/db/tooling';
    const records = collection('records', { _id: string() });
    assert.equal(normalizeDeclarations({ records }).collections.length, 1);
    const db = createDatabase({ uri: 'mongodb://127.0.0.1:1', database: 'unused', collections: { records } });
    await db.close();
  `,
  );
  execFileSync(process.execPath, [join(temporary, 'db-only.mjs')], { stdio: 'inherit' });

  consumer.devDependencies = {
    '@mica/cli': `file:./${cliPackage.filename}`,
    '@types/node': '22.20.4',
  };
  writeFileSync(join(temporary, 'package.json'), JSON.stringify(consumer));
  install();
  const installed = join(temporary, 'node_modules', '@mica', 'cli');
  const executable = join(temporary, 'node_modules', '.bin', 'mica');
  assert.match(execFileSync(executable, ['--help'], { encoding: 'utf8' }), /mica check/);
  writeFileSync(
    join(temporary, 'consumer.mjs'),
    `
    import assert from 'node:assert/strict';
    import { collection, createDatabase, jsonSchema, string, number } from '@mica/db';
    import { defineConfig } from '@mica/cli';
    import { normalizeDeclarations, compareSchemas } from '@mica/db/tooling';
    const Records = collection('records', { _id: string(), count: number().default(0) });
    const graph = normalizeDeclarations({ Records });
    assert.equal(compareSchemas(graph, graph).changes.length, 0);
    assert.equal(defineConfig({ schema: './schema.ts', database: { uri: 'mongodb://127.0.0.1:1', name: 'unused' } }).schema, './schema.ts');
    assert.equal(jsonSchema(Records).$jsonSchema.properties.count.bsonType, 'number');
    const db = createDatabase({ uri: 'mongodb://127.0.0.1:1', database: 'unused', collections: { records: Records } });
    assert.equal(db.status, 'idle');
    await db.close();
  `,
  );
  writeFileSync(
    join(temporary, 'mica.config.ts'),
    `
    import { defineConfig } from '@mica/cli';
    export default defineConfig({ schema: './schema.ts', database: { uri: 'mongodb://127.0.0.1:1', name: 'unused' } });
  `,
  );
  writeFileSync(
    join(temporary, 'schema.ts'),
    `
    import { collection, string } from '@mica/db';
    export default { records: collection('records', { _id: string() }) };
  `,
  );
  const cli = spawnSync(process.execPath, [join(installed, 'dist/bin.js'), 'check'], {
    cwd: temporary,
    encoding: 'utf8',
  });
  assert.equal(cli.status, 2, cli.stdout);
  assert.match(cli.stderr, /ECONNREFUSED|Server selection/);
  writeFileSync(
    join(temporary, 'consumer.ts'),
    `
    import { collection, createDatabase, string, number, object, objectId, map } from '@mica/db';
    import { defineConfig } from '@mica/cli';
    import { normalizeDeclarations, compareSchemas, type SchemaDiff } from '@mica/db/tooling';
    defineConfig({ schema: './schema.ts', database: { uri: 'mongodb://127.0.0.1:1', name: 'unused' } });
    const Records = collection('records', {
      _id: string(), profile: object({ title: string(), count: number().default(0) }), counts: map(number()), ownerId: objectId().optional(),
    });
    const db = createDatabase({ uri: 'mongodb://127.0.0.1:1', database: 'unused', collections: { records: Records } });
    const graph = normalizeDeclarations({ Records });
    compareSchemas(graph, graph) satisfies SchemaDiff;
    async function check() {
      const inserted = await db.records.insertOne({ _id: 'id', profile: { title: 'one' }, counts: {} });
      inserted.insertedId satisfies string;
      const result = await db.records.findOne({}, { projection: { 'profile.title': 1, _id: 0 } });
      if (result) {
        result.profile.title satisfies string;
        // @ts-expect-error excluded fields must remain unavailable in exported declarations
        result.profile.count;
      }
      await db.records.updateOne({}, { $inc: { 'counts.session': 1 } });
      const summary = await db.records.aggregate()
        .group({ _id: '$profile.title', total: { $sum: '$profile.count' } })
        .project({ total: 1, _id: 0 })
        .toArray();
      summary[0].total satisfies number;
      // @ts-expect-error projected group keys remain unavailable in exported declarations
      summary[0]._id;
      // @ts-expect-error group input paths are checked in exported declarations
      db.records.aggregate().group({ _id: '$missing' });
      const owners = await db.records.aggregate()
        .match({ ownerId: '507f1f77bcf86cd799439011' })
        .project({ ownerId: 1, _id: 0 })
        .toArray();
      owners[0].ownerId?.toHexString();
      // @ts-expect-error string ObjectId inputs don't widen the selected ObjectId output
      owners[0].ownerId satisfies string;
      // @ts-expect-error numeric map entries do not accept strings
      await db.records.updateOne({}, { $set: { 'counts.session': 'wrong' } });
    }
    void check;
  `,
  );
  execFileSync(process.execPath, [join(temporary, 'consumer.mjs')], { stdio: 'inherit' });
  execFileSync(
    join(root, 'node_modules', '.bin', 'tsc'),
    [
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      join(temporary, 'consumer.ts'),
    ],
    { cwd: temporary, stdio: 'inherit' },
  );
  console.log(
    `Package smoke passed: isolated @mica/db install, @mica/cli executable, both tarballs and exported TypeScript inference.`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
