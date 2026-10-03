import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'mica-package-'));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

try {
  const [packed] = JSON.parse(
    execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], {
      cwd: root,
      encoding: 'utf8',
    }),
  );
  assert(packed.files.some((file) => file.path === 'LICENSE'));
  assert(packed.files.some((file) => file.path === 'dist/index.js'));
  assert(packed.files.some((file) => file.path === 'dist/index.d.ts'));
  assert(
    packed.files.every(
      (file) =>
        file.path.startsWith('dist/') ||
        ['package.json', 'README.md', 'LICENSE', 'NOTICE'].includes(file.path),
    ),
    'The package must not include tests, fixtures, local logs or example configuration',
  );

  const modules = join(temporary, 'node_modules');
  const installed = join(modules, manifest.name);
  mkdirSync(installed, { recursive: true });
  execFileSync('tar', [
    '-xzf',
    join(temporary, packed.filename),
    '--strip-components=1',
    '-C',
    installed,
  ]);
  // Use the installed dependency without a network install or repository source imports.
  symlinkSync(join(root, 'node_modules', 'mongodb'), join(modules, 'mongodb'), 'dir');
  symlinkSync(join(root, 'node_modules', '@types'), join(modules, '@types'), 'dir');
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ type: 'module', private: true }));
  writeFileSync(
    join(temporary, 'consumer.mjs'),
    `
    import assert from 'node:assert/strict';
    import { collection, createDatabase, jsonSchema, string, number } from ${JSON.stringify(manifest.name)};
    const Records = collection('records', { _id: string(), count: number().default(0) });
    assert.equal(jsonSchema(Records).$jsonSchema.properties.count.bsonType, 'number');
    const db = createDatabase({ uri: 'mongodb://127.0.0.1:1', database: 'unused', collections: { records: Records } });
    assert.equal(db.status, 'idle');
    await db.close();
  `,
  );
  writeFileSync(
    join(temporary, 'consumer.ts'),
    `
    import { collection, createDatabase, string, number, object, objectId, map } from ${JSON.stringify(manifest.name)};
    const Records = collection('records', {
      _id: string(), profile: object({ title: string(), count: number().default(0) }), counts: map(number()), ownerId: objectId().optional(),
    });
    const db = createDatabase({ uri: 'mongodb://127.0.0.1:1', database: 'unused', collections: { records: Records } });
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
    `Package smoke passed: ${packed.files.length} files, runtime import and exported TypeScript inference.`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
