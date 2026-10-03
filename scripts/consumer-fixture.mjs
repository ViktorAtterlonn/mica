import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Each entity has its own field name so the compiler cannot reuse one identical schema everywhere.
export function writeConsumer(directory, count, depth) {
  mkdirSync(join(directory, 'entities'), { recursive: true });
  mkdirSync(join(directory, 'queries'), { recursive: true });
  writeFileSync(
    join(directory, 'fields.ts'),
    `
import { Binary } from 'mongodb';
import { customType, string } from 'mica-mongodb';

// A representation codec, not encryption.
export const encoded = customType({
  base: string,
  metadata: { purpose: 'consumer-fixture' },
  codec: {
    storedSchema: { bsonType: 'binData' },
    encode: (value: string) => new Binary(Buffer.from(value)),
    decode: (value: Binary) => Buffer.from(value.value()).toString(),
  },
});
`,
  );

  let nested = 'string()';
  for (let level = 1; level < depth; level++) {
    nested = `object({ leaf: ${nested}, label: string(), secret: encoded() })`;
  }

  const imports = [];
  const collections = [];
  for (let i = 0; i < count; i++) {
    imports.push(`import { Entity${i} } from './entities/entity-${i}.js';`);
    collections.push(`c${i}: Entity${i}`);
    writeFileSync(
      join(directory, 'entities', `entity-${i}.ts`),
      `
import { array, collection, enum_, index, map, number, object, objectId, string, timestamps } from 'mica-mongodb';
import { encoded } from '../fields.js';

export const Entity${i} = collection('entity_${i}', {
  _id: objectId().auto(),
  title: string(),
  field${i}: string().optional(),
  status: enum_('draft', 'published').default('draft'),
  score: number().default(0),
  fixed: string().immutable(),
  secret: encoded(),
  profile: object({ label: string(), count: number() }).nullable().optional(),
  nested: ${nested},
  rows: array(object({ label: string(), score: number(), secret: encoded() })),
  counts: map(number()),
  ...timestamps(),
}, (t) => [index('status_score').on(t.status, t.score.desc())]);
`,
    );
    writeFileSync(
      join(directory, 'queries', `query-${i}.ts`),
      `
import { Binary, ObjectId } from 'mongodb';
import { arrayFilter, type Filter } from 'mica-mongodb';
import { Entity${i} } from '../entities/entity-${i}.js';
import { db } from '../database.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function expect<T extends true>() {}
expect<Equal<typeof Entity${i}.$inferStored.secret, Binary>>();
expect<Equal<typeof Entity${i}.$inferInsert.secret, string>>();
expect<Equal<typeof Entity${i}.$inferSelect.secret, string>>();

const filter: Filter<typeof Entity${i}.$fields> = { status: 'published', 'rows.score': { $gte: 1 } };
export async function queries() {
  const full = await db.c${i}.findOne({ field${i}: 'own field' });
  full?.nested.leaf;
  full?.secret satisfies string | undefined;
  const selected = (await db.c${i}.find(filter, {
    projection: { title: 1, secret: 1, 'profile.label': 1, 'rows.label': 1, _id: 0 },
  }))[0]!;
  expect<Equal<typeof selected.secret, string>>();
  selected.profile?.label satisfies string | undefined;
  selected.rows[0]!.label satisfies string;
  // @ts-expect-error unselected nested sibling
  selected.profile?.count;
  // @ts-expect-error unselected array sibling
  selected.rows[0]!.score;
  // @ts-expect-error excluded ID
  selected._id;
  const cursor = db.c${i}.cursor({}, { projection: { title: 1, _id: 0 } });
  for await (const row of cursor) {
    expect<Equal<typeof row.title, string>>();
    // @ts-expect-error cursor projection
    row.score;
  }
  for await (const batch of db.c${i}.chunks({}, { size: 25, projection: { title: 1, _id: 0 } })) {
    batch[0]!.title satisfies string;
    // @ts-expect-error chunk projection
    batch[0]!._id;
  }
  await db.c${i}.updateMany(filter, {
    $set: { 'rows.$[row].secret': 'new' }, $inc: { 'counts.view': 1 },
  }, { arrayFilters: [arrayFilter('row', Entity${i}.rows, { score: { $gte: 1 } })] });
  // @ts-expect-error array filter operand type
  arrayFilter('row', Entity${i}.rows, { score: 'wrong' });
  // @ts-expect-error immutable fields cannot be updated
  db.c${i}.updateOne({}, { $set: { fixed: 'new' } });
  // @ts-expect-error map entry operand type
  db.c${i}.updateOne({}, { $inc: { 'counts.view': 'wrong' } });
  // @ts-expect-error codec writes use application values
  db.c${i}.updateOne({}, { $set: { secret: new Binary() } });
  const base = db.c${i}.aggregate().match({ _id: '507f1f77bcf86cd799439011' });
  const ids = await base.project({ _id: 1 }).toArray();
  expect<Equal<typeof ids[number]['_id'], ObjectId>>();
  const grouped = base.group({ _id: '$status', total: { $sum: '$score' }, average: { $avg: '$score' } });
  const result = await grouped.match({ total: { $gt: 1 } }).sort({ total: -1 })
    .skip(1).limit(10).project({ total: 1, average: 1, _id: 0 }).toArray();
  expect<Equal<typeof result[number]['total'], number>>();
  expect<Equal<typeof result[number]['average'], number | null>>();
  // @ts-expect-error group output replaces original fields
  grouped.match({ title: 'old shape' });
  // @ts-expect-error projected group key
  result[0]!._id;
}
`,
    );
  }
  writeFileSync(
    join(directory, 'database.ts'),
    `
import { createDatabase } from 'mica-mongodb';
${imports.join('\n')}

export const db = createDatabase({
  uri: 'mongodb://127.0.0.1:1', database: 'unused_consumer',
  collections: { ${collections.join(',\n')} },
});
`,
  );
}
