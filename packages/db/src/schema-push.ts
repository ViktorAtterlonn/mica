import { isDeepStrictEqual } from 'node:util';
import type { Db } from 'mongodb';
import type { SchemaChange, SchemaDiff } from './schema-model.js';
import { introspectDatabase } from './schema-introspect.js';
import { compareSchemas } from './schema-diff.js';
import { indexDocument, validatorDocument } from './schema-normalize.js';

/** Apply a previously reviewed plan. Refuse unsupported or stale metadata before any write. */
export async function applySchemaDiff(db: Db, diff: SchemaDiff): Promise<SchemaDiff> {
  if (!isDeepStrictEqual(diff, compareSchemas(diff.desired, diff.actual)))
    throw new Error('Schema plan does not match its snapshots');
  if (diff.changes.some((change) => change.kind === 'unsupported'))
    throw new Error('Unsupported configuration blocks push; no changes were applied');
  const names = diff.desired.collections.map((c) => c.name);
  const fresh = await introspectDatabase(db, names);
  if (!isDeepStrictEqual(fresh, diff.actual))
    throw new Error('Database metadata changed after planning; run diff and push again');
  const created = new Set<string>();
  for (const change of diff.changes) {
    try {
      await applyChange(db, change, created);
    } catch (cause) {
      const index =
        change.kind === 'index-added' || change.kind === 'index-changed'
          ? change.after.name
          : change.kind === 'index-removed'
            ? change.before.name
            : '';
      throw new Error(
        `${change.collection}${index ? `.${index}` : ''}: ${change.kind} failed: ${cause instanceof Error ? cause.message : String(cause)}. Earlier operations may have succeeded; inspect diff before retrying.`,
        { cause },
      );
    }
  }
  return compareSchemas(diff.desired, await introspectDatabase(db, names));
}

async function applyChange(db: Db, change: SchemaChange, created: Set<string>): Promise<void> {
  switch (change.kind) {
    case 'collection-added':
      await db.createCollection(change.collection, {
        validator: validatorDocument(change.after.validator),
        validationLevel: change.after.validator.level,
        validationAction: change.after.validator.action,
      });
      created.add(change.collection);
      return;
    case 'validator-added':
    case 'validator-removed':
    case 'validator-changed':
      if (!created.has(change.collection))
        await db.command({
          collMod: change.collection,
          validator: validatorDocument(change.after),
          validationLevel: change.after.level,
          validationAction: change.after.action,
        });
      return;
    case 'index-added':
      await db.collection(change.collection).createIndexes([indexDocument(change.after)]);
      return;
    case 'index-changed':
      await db.collection(change.collection).dropIndex(change.before.name);
      await db.collection(change.collection).createIndexes([indexDocument(change.after)]);
      return;
    case 'index-removed':
      await db.collection(change.collection).dropIndex(change.before.name);
      return;
    case 'unsupported':
      throw new Error('Unsupported schema change');
  }
}
