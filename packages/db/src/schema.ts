import type { IndexDescription } from 'mongodb';
import { defineIndexes, type IndexFields, type IndexDeclaration } from './indexes.js';
import type { AnyField, Fields, InferFields, JsonSchema } from './fields.js';
import { checkFields, mapKeyPattern } from './fields.js';
import type { Update } from './query-types.js';

export interface CollectionSchema<F extends Fields = Fields> {
  readonly $name: string;
  readonly $fields: F;
  readonly $indexes: IndexDescription[];
  readonly $inferSelect: InferFields<F, 'app'>;
  readonly $inferInsert: InferFields<F, 'insert'>;
  readonly $inferStored: InferFields<F, 'stored'>;
  readonly $inferUpdate: Update<F>;
}

export function collection<const F extends Fields>(
  name: string,
  fields: F,
  indexes?: (fields: IndexFields<NoInfer<F>>) => readonly IndexDeclaration[],
): CollectionSchema<F> & F {
  checkFields(fields);

  for (const key of [
    '$name',
    '$fields',
    '$indexes',
    '$inferSelect',
    '$inferInsert',
    '$inferStored',
    '$inferUpdate',
  ]) {
    if (key in fields) {
      throw new Error(`Reserved schema field: ${key}`);
    }
  }

  if (
    !fields._id ||
    !['objectId', 'string'].includes(fields._id.definition.kind) ||
    fields._id.definition.optional ||
    fields._id.definition.nullable ||
    fields._id.definition.codec
  ) {
    throw new Error(
      'Collections require a non-null, required objectId or string _id without a codec',
    );
  }

  // The runtime walker checks reference ownership and enumerates the same bounded paths.
  const getIndexes = defineIndexes(fields, indexes as Parameters<typeof defineIndexes>[1]);
  const schema = {
    $name: name,
    $fields: Object.freeze({ ...fields }),
    get $indexes() {
      return getIndexes();
    },
    ...fields,
  };
  // Inference markers exist only in the type system.
  return Object.freeze(schema) as CollectionSchema<F> & F;
}

export function jsonSchema(schema: CollectionSchema): { $jsonSchema: JsonSchema } {
  return { $jsonSchema: objectSchema(schema.$fields) };
}

function objectSchema(fields: Fields): JsonSchema {
  const required = Object.entries(fields)
    .filter(([, f]) => !f.definition.optional)
    .map(([key]) => key);

  return {
    bsonType: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(
      Object.entries(fields).map(([key, field]) => [key, fieldSchema(field)]),
    ),
    ...(required.length ? { required } : {}),
  };
}

function fieldSchema(field: AnyField): JsonSchema {
  const result = storedFieldSchema(field);
  if (!field.definition.nullable) return result;
  return { anyOf: [result, { bsonType: 'null' }] };
}

function storedFieldSchema(field: AnyField): JsonSchema {
  const definition = field.definition;
  if (definition.codec) return { ...definition.codec.storedSchema };
  if (definition.storedSchema) return { ...definition.storedSchema };

  let result: JsonSchema;
  if (definition.kind === 'custom') {
    throw new Error('Custom values require a stored JSON Schema');
  }

  const bsonType = {
    string: 'string',
    number: 'number',
    boolean: 'bool',
    date: 'date',
    objectId: 'objectId',
    binary: 'binData',
    object: 'object',
    array: 'array',
    map: 'object',
  }[definition.kind];

  if (definition.kind === 'map') {
    result = {
      bsonType: 'object',
      additionalProperties: false,
      patternProperties: { [mapKeyPattern]: fieldSchema(definition.element!) },
    };
  } else if (definition.fields) {
    result = objectSchema(definition.fields);
  } else if (definition.element) {
    result = { bsonType, items: fieldSchema(definition.element) };
  } else {
    result = { bsonType };
  }

  if (definition.values) {
    result.enum = [...definition.values];
  }

  if (definition.pattern) {
    result.pattern = definition.pattern.source;
  }

  if (definition.integer) {
    result.multipleOf = 1;
  }

  let minimumKey = 'minimum';
  let maximumKey = 'maximum';

  if (definition.kind === 'string') {
    minimumKey = 'minLength';
    maximumKey = 'maxLength';
  } else if (definition.kind === 'array') {
    minimumKey = 'minItems';
    maximumKey = 'maxItems';
  }

  if (definition.min !== undefined) {
    result[minimumKey] = definition.min;
  }

  if (definition.max !== undefined) {
    result[maximumKey] = definition.max;
  }
  return result;
}

export function discoverMetadata(
  schema: CollectionSchema,
  key: string,
): { path: string; value: unknown }[] {
  const found: { path: string; value: unknown }[] = [];
  function visit(field: AnyField, path: string) {
    const definition = field.definition;

    if (definition.metadata && Object.hasOwn(definition.metadata, key)) {
      found.push({ path, value: definition.metadata[key] });
    }

    for (const [name, child] of Object.entries(definition.fields ?? {})) {
      visit(child, `${path}.${name}`);
    }

    if (definition.element) {
      visit(definition.element, definition.kind === 'map' ? `${path}.*` : `${path}[]`);
    }
  }

  for (const [name, field] of Object.entries(schema.$fields)) {
    visit(field, name);
  }

  return found;
}
