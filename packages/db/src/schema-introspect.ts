import type { Db } from 'mongodb';
import type { DatabaseSchema, NormalizedCollection } from './schema-model.js';
import { issue, normalizeIndex, normalizeValidator } from './schema-normalize.js';
import { compareNames } from './schema-model.js';
import { emptyValidator } from './schema-diff.js';

/** Metadata only: never queries application documents or inspects unrelated collections. */
export async function introspectDatabase(
  db: Db,
  names: readonly string[],
): Promise<DatabaseSchema> {
  const collections: NormalizedCollection[] = [];
  for (const name of [...names].sort(compareNames)) {
    const [metadata] = await db.listCollections({ name }, { nameOnly: false }).toArray();
    if (!metadata) {
      collections.push({
        name,
        exists: false,
        validator: emptyValidator(),
        indexes: [],
        issues: [],
      });
      continue;
    }
    const options = metadata.options ?? {};
    const { validator, issues } = normalizeValidator(
      options.validator,
      options.validationLevel,
      options.validationAction,
    );
    if (metadata.type !== 'collection')
      issues.push(issue('collection', 'unsupported-collection-type', ['type'], metadata.type));
    for (const [key, value] of Object.entries(options).sort(([a], [b]) => compareNames(a, b))) {
      if (['validator', 'validationLevel', 'validationAction'].includes(key)) continue;
      if (key === 'capped' && value === false) continue;
      issues.push(issue('collection', 'unsupported-collection-option', [key], value));
    }
    const indexes =
      metadata.type === 'collection'
        ? (await db.collection(name).listIndexes().toArray())
            .filter(
              (index) =>
                !(
                  index.name === '_id_' &&
                  Object.keys(index.key).length === 1 &&
                  index.key._id === 1
                ),
            )
            .map(normalizeIndex)
            .sort((a, b) => compareNames(a.name, b.name))
        : [];
    collections.push({ name, exists: true, validator, indexes, issues });
  }
  return { collections };
}
