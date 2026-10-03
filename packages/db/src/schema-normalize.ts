import { BSON, type Document, type IndexDescription } from 'mongodb';
import { isDeepStrictEqual } from 'node:util';
import { jsonSchema, type CollectionSchema } from './schema.js';
import type {
  DatabaseSchema,
  NormalizedCollection,
  NormalizedIndex,
  NormalizedValidator,
  PartialPredicate,
  SchemaIssue,
  SchemaObject,
  SchemaValue,
} from './schema-model.js';

import { compareNames } from './schema-model.js';
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Literal BSON document order is significant. Never sort keys inside stored literals. */
export function literal(value: unknown): string {
  return BSON.EJSON.stringify(value, { relaxed: false });
}
export function readLiteral(value: string): unknown {
  return BSON.EJSON.parse(value, { relaxed: true });
}
export function issue(
  scope: SchemaIssue['scope'],
  code: string,
  path: string[],
  source: unknown,
): SchemaIssue {
  return { scope, code, path, source: literal(source) };
}

function sortedSet<T>(values: T[]): T[] {
  return values
    .sort((a, b) => compareNames(JSON.stringify(a), JSON.stringify(b)))
    .filter((value, i, all) => i === 0 || !isDeepStrictEqual(value, all[i - 1]));
}

const scalarKeywords = new Set([
  'title',
  'description',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
]);
const bsonTypes = new Set([
  'double',
  'string',
  'object',
  'array',
  'binData',
  'undefined',
  'objectId',
  'bool',
  'date',
  'null',
  'regex',
  'dbPointer',
  'javascript',
  'symbol',
  'javascriptWithScope',
  'int',
  'timestamp',
  'long',
  'decimal',
  'minKey',
  'maxKey',
  'number',
]);

function normalizeJsonSchema(input: unknown, path: string[], issues: SchemaIssue[]): SchemaObject {
  if (!isPlainObject(input)) {
    issues.push(issue('validator', 'invalid-schema', path, input));
    return {};
  }
  const entries: [string, SchemaValue][] = [];
  for (const [key, value] of Object.entries(input).sort(([a], [b]) => compareNames(a, b))) {
    const at = [...path, key];
    if (key === 'properties' || key === 'patternProperties') {
      if (!isPlainObject(value)) {
        issues.push(issue('validator', 'invalid-schema', at, value));
        continue;
      }
      entries.push([
        key,
        Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => compareNames(a, b))
            .map(([name, child]) => [name, normalizeJsonSchema(child, [...at, name], issues)]),
        ),
      ]);
      continue;
    }
    if (key === 'additionalProperties' || key === 'additionalItems') {
      if (value === true) continue;
      entries.push([
        key,
        typeof value === 'boolean' ? value : normalizeJsonSchema(value, at, issues),
      ]);
      continue;
    }
    if (key === 'items' || key === 'not') {
      entries.push([
        key,
        Array.isArray(value) && key === 'items'
          ? value.map((v, i) => normalizeJsonSchema(v, [...at, String(i)], issues))
          : normalizeJsonSchema(value, at, issues),
      ]);
      continue;
    }
    if (['anyOf', 'allOf', 'oneOf'].includes(key)) {
      if (!Array.isArray(value)) {
        issues.push(issue('validator', 'invalid-schema', at, value));
        continue;
      }
      const branches = value.map((v, i) => normalizeJsonSchema(v, [...at, String(i)], issues));
      // Duplicated oneOf branches affect meaning, unlike anyOf/allOf.
      entries.push([
        key,
        key === 'oneOf'
          ? branches.sort((a, b) => compareNames(JSON.stringify(a), JSON.stringify(b)))
          : sortedSet(branches),
      ]);
      continue;
    }
    if (key === 'required' || key === 'bsonType' || key === 'type') {
      const values = Array.isArray(value) ? value : [value];
      if (
        values.some((v) => typeof v !== 'string') ||
        (key === 'required' && !Array.isArray(value)) ||
        (key === 'bsonType' && values.some((v) => !bsonTypes.has(v as string)))
      ) {
        issues.push(issue('validator', 'unsupported-schema-value', at, value));
        continue;
      }
      const normalized = sortedSet(values as string[]);
      if (key === 'required' && normalized.length === 0) continue;
      entries.push([
        key,
        key !== 'required' && normalized.length === 1 ? normalized[0]! : normalized,
      ]);
      continue;
    }
    if (key === 'enum' && Array.isArray(value)) {
      entries.push([key, sortedSet(value.map((v) => literal(v)))]);
      continue;
    }
    if (
      scalarKeywords.has(key) &&
      ['string', 'number', 'boolean'].includes(typeof value) &&
      (typeof value !== 'number' || Number.isFinite(value))
    ) {
      if (['uniqueItems', 'exclusiveMinimum', 'exclusiveMaximum'].includes(key) && value === false)
        continue;
      entries.push([key, value as SchemaValue]);
      continue;
    }
    issues.push(issue('validator', 'unsupported-schema-keyword', at, value));
  }
  return Object.fromEntries(entries);
}

function restoreJsonSchema(schema: SchemaValue, keyword?: string): unknown {
  if (keyword === 'enum')
    return (schema as string[]).map((value) => BSON.EJSON.parse(value, { relaxed: false }));
  if (Array.isArray(schema)) return schema.map((value) => restoreJsonSchema(value));
  if (schema === null || typeof schema !== 'object') return schema;

  const entries: [string, unknown][] = [];
  for (const [key, value] of Object.entries(schema)) {
    // Property names are application data, even when they match schema keywords.
    if (key === 'properties' || key === 'patternProperties') {
      const properties = Object.entries(value as SchemaObject).map(([name, child]) => [
        name,
        restoreJsonSchema(child),
      ]);
      entries.push([key, Object.fromEntries(properties)]);
      continue;
    }
    entries.push([key, restoreJsonSchema(value, key)]);
  }
  return Object.fromEntries(entries);
}

export function validatorDocument(validator: NormalizedValidator): Document {
  if (validator.schema === null) return {};
  return { $jsonSchema: restoreJsonSchema(validator.schema) };
}

export function normalizeValidator(
  raw: unknown = {},
  level = 'strict',
  action = 'error',
): { validator: NormalizedValidator; issues: SchemaIssue[] } {
  const issues: SchemaIssue[] = [];
  let schema: SchemaObject | null = null;
  if (!isPlainObject(raw) || Object.keys(raw).some((key) => key !== '$jsonSchema')) {
    issues.push(issue('validator', 'unsupported-validator-expression', [], raw));
  } else if ('$jsonSchema' in raw) {
    schema = normalizeJsonSchema(raw.$jsonSchema, ['$jsonSchema'], issues);
  }
  if (!['strict', 'moderate', 'off'].includes(level))
    issues.push(issue('validator', 'unsupported-validation-level', ['validationLevel'], level));
  if (!['error', 'warn'].includes(action))
    issues.push(issue('validator', 'unsupported-validation-action', ['validationAction'], action));
  return {
    validator: {
      schema,
      level: schema === null && !issues.length ? 'strict' : level,
      action: schema === null && !issues.length ? 'error' : action,
    },
    issues,
  };
}

function combine(kind: 'and' | 'or', terms: PartialPredicate[]): PartialPredicate {
  const flat = sortedSet(terms.flatMap((term) => (term.kind === kind ? term.terms : [term])));
  return flat.length === 1 ? flat[0]! : { kind, terms: flat };
}

function checkPartialLiteral(value: unknown): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return;
  if (value instanceof Date || value instanceof BSON.ObjectId || value instanceof BSON.Binary)
    return;
  if (Array.isArray(value)) {
    value.forEach(checkPartialLiteral);
    return;
  }
  if (isPlainObject(value) && !Object.keys(value).some((key) => key.startsWith('$'))) {
    Object.values(value).forEach(checkPartialLiteral);
    return;
  }
  throw new Error('Unsupported BSON partial literal');
}

function normalizePartial(raw: unknown): PartialPredicate {
  if (!isPlainObject(raw) || !Object.keys(raw).length) throw new Error('Invalid partial filter');
  const terms: PartialPredicate[] = [];
  for (const [path, value] of Object.entries(raw)) {
    if (path === '$and' || path === '$or') {
      if (!Array.isArray(value) || !value.length) throw new Error('Invalid logical filter');
      terms.push(combine(path === '$and' ? 'and' : 'or', value.map(normalizePartial)));
      continue;
    }
    if (path.startsWith('$')) throw new Error('Unsupported partial filter');
    const conditions =
      isPlainObject(value) && Object.keys(value).some((k) => k.startsWith('$'))
        ? Object.entries(value)
        : [['$eq', value] as const];
    for (const [operator, operand] of conditions) {
      if (!['$eq', '$gt', '$gte', '$lt', '$lte', '$in', '$exists', '$type'].includes(operator))
        throw new Error('Unsupported partial operator');
      if (operator === '$exists' && operand !== true) throw new Error('Unsupported exists');
      if (operator === '$type' && (typeof operand !== 'string' || !bsonTypes.has(operand)))
        throw new Error('Unsupported type');
      if (operator === '$in' && (!Array.isArray(operand) || !operand.length))
        throw new Error('Invalid in');
      checkPartialLiteral(operand);
      terms.push({
        kind: 'condition',
        path,
        operator,
        value:
          operator === '$in'
            ? JSON.stringify(sortedSet((operand as unknown[]).map(literal)))
            : literal(operand),
      });
    }
  }
  return combine('and', terms);
}

export function partialDocument(predicate: PartialPredicate): Document {
  if (predicate.kind !== 'condition')
    return { [predicate.kind === 'and' ? '$and' : '$or']: predicate.terms.map(partialDocument) };
  return {
    [predicate.path]: {
      [predicate.operator]:
        predicate.operator === '$in'
          ? (JSON.parse(predicate.value) as string[]).map(readLiteral)
          : readLiteral(predicate.value),
    },
  };
}

export function normalizeIndex(raw: IndexDescription | Document): NormalizedIndex {
  const issues: SchemaIssue[] = [];
  const name = String(raw.name);
  if (!raw.name || name === '*' || name === '_id_' || name.includes('\0'))
    issues.push(issue('index', 'unsupported-index-name', [name], raw.name));
  let keys: [string, unknown][] = [];
  if (raw.key instanceof Map) keys = [...raw.key];
  else if (isPlainObject(raw.key)) keys = Object.entries(raw.key);
  const supported = new Set([
    'name',
    'key',
    'v',
    'ns',
    'background',
    'unique',
    'sparse',
    'partialFilterExpression',
    'expireAfterSeconds',
  ]);
  for (const key of Object.keys(raw).sort(compareNames)) {
    if (key === 'hidden' && raw[key] === false) continue;
    if (!supported.has(key))
      issues.push(issue('index', 'unsupported-index-option', [name, key], (raw as Document)[key]));
  }
  if (
    !keys.length ||
    keys.some(
      ([path, direction]) =>
        (direction !== 1 && direction !== -1) ||
        /(^|\.)\$\*\*$/.test(path) ||
        /^(0|[1-9]\d*)$/.test(path),
    )
  ) {
    issues.push(
      issue(
        'index',
        'unsupported-index-keys',
        [name, 'key'],
        raw.key instanceof Map ? [...raw.key] : raw.key,
      ),
    );
  }
  let partial: PartialPredicate | null = null;
  if (raw.partialFilterExpression !== undefined) {
    try {
      partial = normalizePartial(raw.partialFilterExpression);
    } catch {
      issues.push(
        issue(
          'index',
          'unsupported-partial-filter',
          [name, 'partialFilterExpression'],
          raw.partialFilterExpression,
        ),
      );
    }
  }
  for (const key of ['unique', 'sparse'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean')
      issues.push(issue('index', 'invalid-index-option', [name, key], (raw as Document)[key]));
  }
  const ttl = raw.expireAfterSeconds;
  if (
    ttl !== undefined &&
    (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 0 || ttl > 2_147_483_647)
  )
    issues.push(issue('index', 'unsupported-ttl', [name, 'expireAfterSeconds'], ttl));
  return {
    name,
    keys: keys.filter((entry): entry is [string, 1 | -1] => entry[1] === 1 || entry[1] === -1),
    unique: raw.unique === true,
    sparse: raw.sparse === true,
    partial,
    expireAfterSeconds: ttl ?? null,
    issues,
  };
}

export function indexDocument(index: NormalizedIndex): IndexDescription {
  return {
    name: index.name,
    key: new Map(index.keys),
    ...(index.unique ? { unique: true } : {}),
    ...(index.sparse ? { sparse: true } : {}),
    ...(index.partial ? { partialFilterExpression: partialDocument(index.partial) } : {}),
    ...(index.expireAfterSeconds !== null ? { expireAfterSeconds: index.expireAfterSeconds } : {}),
  };
}

export function normalizeDeclarations(
  collections: Record<string, CollectionSchema>,
): DatabaseSchema {
  if (!isPlainObject(collections) || !Object.keys(collections).length)
    throw new Error('Schema must default-export a nonempty collection registry');

  const names = new Set<string>();
  const normalized: NormalizedCollection[] = [];
  for (const collection of Object.values(collections)) {
    if (
      !collection ||
      typeof collection.$name !== 'string' ||
      !collection.$fields ||
      !Array.isArray(collection.$indexes)
    )
      throw new Error('Schema registry must contain Mica collection declarations');

    const name = collection.$name;
    if (!name || name.includes('\0') || name.startsWith('system.') || names.has(name))
      throw new Error(`Invalid or duplicate collection name: ${name}`);
    names.add(name);

    const { validator, issues } = normalizeValidator(jsonSchema(collection));
    const indexes = collection.$indexes
      .map(normalizeIndex)
      .sort((a, b) => compareNames(a.name, b.name));
    normalized.push({ name, exists: true, validator, issues, indexes });
  }
  normalized.sort((a, b) => compareNames(a.name, b.name));
  return { collections: normalized };
}
