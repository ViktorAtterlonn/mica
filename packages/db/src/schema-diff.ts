import { isDeepStrictEqual } from 'node:util';
import { compareNames } from './schema-model.js';
import type {
  DatabaseSchema,
  NormalizedValidator,
  SchemaChange,
  SchemaDiff,
  SchemaValue,
  ValueDifference,
} from './schema-model.js';

const changeOrder: Record<SchemaChange['kind'], number> = {
  unsupported: 0,
  'collection-added': 1,
  'validator-added': 2,
  'validator-removed': 2,
  'validator-changed': 2,
  'index-removed': 3,
  'index-changed': 4,
  'index-added': 5,
};

export function valueDifferences(
  before: SchemaValue,
  after: SchemaValue,
  path: string[] = [],
): ValueDifference[] {
  if (isDeepStrictEqual(before, after)) return [];
  if (
    before &&
    after &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort(compareNames)
      .flatMap((key) => {
        if (!Object.hasOwn(before, key)) return [{ path: [...path, key], after: after[key]! }];
        if (!Object.hasOwn(after, key)) return [{ path: [...path, key], before: before[key]! }];
        return valueDifferences(before[key]!, after[key]!, [...path, key]);
      });
  }
  return [{ path, before, after }];
}

export const emptyValidator = (): NormalizedValidator => ({
  schema: null,
  level: 'strict',
  action: 'error',
});

export function compareSchemas(desired: DatabaseSchema, actual: DatabaseSchema): SchemaDiff {
  const changes: SchemaChange[] = [];
  const unmanagedIndexes: SchemaDiff['unmanagedIndexes'] = [];
  for (const target of [...desired.collections].sort((a, b) => compareNames(a.name, b.name))) {
    const deployed = actual.collections.find((c) => c.name === target.name);
    const collection = target.name;
    const actualValidator = deployed?.validator ?? emptyValidator();
    for (const [side, schema] of [
      ['desired', target],
      ['actual', deployed],
    ] as const) {
      if (!schema) continue;
      for (const issue of [...schema.issues, ...schema.indexes.flatMap((i) => i.issues)].sort(
        (a, b) => compareNames(JSON.stringify(a), JSON.stringify(b)),
      )) {
        changes.push({ kind: 'unsupported', collection, risks: [], side, issue });
      }
    }
    if (!deployed?.exists)
      changes.push({ kind: 'collection-added', collection, risks: [], after: target });
    const validatorBlocked = [...target.issues, ...(deployed?.issues ?? [])].some(
      (i) => i.scope === 'validator' || i.scope === 'collection',
    );
    if (!validatorBlocked && !isDeepStrictEqual(target.validator, actualValidator)) {
      let kind: 'validator-added' | 'validator-removed' | 'validator-changed' = 'validator-changed';
      if (actualValidator.schema === null) kind = 'validator-added';
      else if (target.validator.schema === null) kind = 'validator-removed';
      changes.push({
        kind,
        collection,
        risks: ['existing-data'],
        before: actualValidator,
        after: target.validator,
        details: valueDifferences({ ...actualValidator }, { ...target.validator }),
      });
    }
    const names = [
      ...new Set([...target.indexes, ...(deployed?.indexes ?? [])].map((i) => i.name)),
    ].sort(compareNames);
    for (const name of names) {
      const after = target.indexes.find((i) => i.name === name);
      const before = deployed?.indexes.find((i) => i.name === name);
      if (before?.issues.length || after?.issues.length) continue;
      if (!after) {
        if (!before) continue;
        if (name.startsWith('mica_'))
          changes.push({ kind: 'index-removed', collection, before, risks: ['index-drop'] });
        else unmanagedIndexes.push({ collection, index: before });
        continue;
      }

      if (!before) {
        const risks: SchemaChange['risks'] = [];
        if (after.unique) risks.push('existing-data');
        if (after.expireAfterSeconds !== null) risks.push('ttl-deletion');
        changes.push({ kind: 'index-added', collection, after, risks });
        continue;
      }

      if (isDeepStrictEqual(after, before)) continue;
      const risks: SchemaChange['risks'] = ['index-rebuild', 'existing-data'];
      if (after.expireAfterSeconds !== null) risks.push('ttl-deletion');
      changes.push({ kind: 'index-changed', collection, before, after, risks });
    }
  }
  changes.sort(
    (a, b) => compareNames(a.collection, b.collection) || changeOrder[a.kind] - changeOrder[b.kind],
  );
  return { version: 1, desired, actual, changes, unmanagedIndexes };
}
