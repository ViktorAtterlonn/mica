import { BSON, type IndexDescription, type Document } from 'mongodb';

import type { AnyField, Fields } from './fields.js';
import type { Entries } from './query-types.js';
import { bsonTypeNames, record, type BsonType } from './validation.js';

const fieldSchema = Symbol('index field schema');
const declaration = Symbol('index declaration');
const ttlCapable = Symbol('TTL capable');

interface Reference {
  scope: object;
  path: string;
  direction: 1 | -1;
  ttl: boolean;
}

const references = new WeakMap<object, Reference>();

/** Callback-local field reference; never an application field builder. */
export class IndexField<P, TTL extends boolean = boolean> {
  declare readonly [ttlCapable]: TTL;
  declare readonly [fieldSchema]: P;

  constructor(reference: Reference) {
    references.set(this, reference);
    Object.freeze(this);
  }

  asc(): IndexField<P, TTL> {
    return new IndexField({ ...references.get(this)!, direction: 1 });
  }

  desc(): IndexField<P, TTL> {
    return new IndexField({ ...references.get(this)!, direction: -1 });
  }
}

type TTLField<F extends AnyField> = F['$types']['codec'] extends false
  ? F['$types']['kind'] extends 'date'
    ? true
    : F['$types']['kind'] extends 'array'
      ? F['$types']['element'] extends AnyField
        ? F['$types']['element']['$types']['codec'] extends false
          ? F['$types']['element']['$types']['kind'] extends 'date'
            ? true
            : false
          : false
        : false
      : false
  : false;

export type IndexFields<F extends Fields> = F extends unknown
  ? {
      readonly [E in Entries<F, [], true, false> as E['path']]: IndexField<
        PartialIndexFilter<F>,
        TTLField<E['field']>
      >;
    }
  : never;

type MatchValue<V> = V extends (infer Element)[] ? V | Element : V;
type PartialCondition<V> =
  | MatchValue<V>
  | {
      $eq?: MatchValue<V>;
      $gt?: MatchValue<V>;
      $gte?: MatchValue<V>;
      $lt?: MatchValue<V>;
      $lte?: MatchValue<V>;
      $in?: MatchValue<V>[];
      $exists?: true;
      $type?: BsonType;
    };

/** Partial index predicates describe stored BSON values; they never run application codecs. */
export type PartialIndexFilter<F extends Fields> = F extends unknown
  ? {
      [E in Entries<F, [], true, false> as E['path']]?: PartialCondition<
        E['field']['$types']['stored']
      >;
    } & {
      $and?: PartialIndexFilter<F>[];
      $or?: PartialIndexFilter<F>[];
    }
  : never;

interface IndexState {
  name: string;
  keys: readonly Reference[];
  unique?: true;
  sparse?: true;
  partial?: Uint8Array;
  expireAfterSeconds?: number;
}

export interface IndexDeclaration {
  readonly [declaration]: IndexState;
}

export class IndexDefinition<P, TTL extends boolean = boolean> implements IndexDeclaration {
  declare readonly [ttlCapable]: TTL;
  readonly [declaration]: IndexState;

  constructor(
    state: IndexState,
    private readonly paths: ReadonlySet<string>,
  ) {
    this[declaration] = Object.freeze(state);
    Object.freeze(this);
  }

  expireAfterSeconds(this: IndexDefinition<P, true>, seconds: number): IndexDefinition<P, true> {
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 2_147_483_647) {
      throw new Error('expireAfterSeconds requires an integer from 0 to 2147483647');
    }
    const { keys } = this[declaration];
    if (keys.length !== 1 || !keys[0]!.ttl) {
      throw new Error('TTL indexes require a single date field or date array without a codec');
    }
    return new IndexDefinition({ ...this[declaration], expireAfterSeconds: seconds }, this.paths);
  }

  unique(): IndexDefinition<P, TTL> {
    return new IndexDefinition<P, TTL>({ ...this[declaration], unique: true }, this.paths);
  }

  sparse(): IndexDefinition<P, TTL> {
    if (this[declaration].partial) {
      throw new Error('An index cannot be both sparse and partial');
    }

    return new IndexDefinition<P, TTL>({ ...this[declaration], sparse: true }, this.paths);
  }

  partial(filter: P): IndexDefinition<P, TTL> {
    if (this[declaration].sparse) {
      throw new Error('An index cannot be both sparse and partial');
    }

    checkPartialFilter(filter, this.paths);

    return new IndexDefinition<P, TTL>(
      { ...this[declaration], partial: BSON.serialize(filter as Document) },
      this.paths,
    );
  }
}

const scopes = new WeakMap<object, ReadonlySet<string>>();

export function index(name: string) {
  if (typeof name !== 'string' || !name.trim() || name.includes('\0') || name === '_id_') {
    throw new Error('Index names must be nonempty, contain no null bytes, and not be _id_');
  }

  return Object.freeze({
    on<T extends IndexField<unknown>, R extends IndexField<NoInfer<T[typeof fieldSchema]>>[]>(
      ...fields: [T, ...R]
    ): IndexDefinition<T[typeof fieldSchema], R extends [] ? T[typeof ttlCapable] : false> {
      if (!fields.length) {
        throw new Error('An index requires at least one field');
      }

      const keys = fields.map((field) => {
        const reference = references.get(field);
        if (!reference)
          throw new Error('Index keys must be references from the collection callback');
        return reference;
      });
      const scope = keys[0]!.scope;
      if (keys.some((key) => key.scope !== scope)) {
        throw new Error('Index keys must belong to the same collection callback');
      }
      if (new Set(keys.map((key) => key.path)).size !== keys.length) {
        throw new Error('An index cannot repeat a field');
      }
      if (keys.length === 1 && keys[0]!.path === '_id') {
        throw new Error('MongoDB owns the single-field _id index');
      }

      return new IndexDefinition<
        T[typeof fieldSchema],
        R extends [] ? T[typeof ttlCapable] : false
      >({ name, keys: Object.freeze(keys) }, scopes.get(scope)!);
    },
  });
}

function checkLiteral(value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (value instanceof Date && Number.isFinite(value.getTime())) return;
  if (value instanceof BSON.ObjectId || value instanceof BSON.Binary) return;
  if (Array.isArray(value)) {
    for (const item of value) checkLiteral(item);
    return;
  }

  record(value, 'Partial index literal');
  Object.values(value).forEach(checkLiteral);
}

function checkPartialFilter(filter: unknown, paths: ReadonlySet<string>): void {
  record(filter, 'Partial index filter');
  if (!Object.keys(filter).length) throw new Error('Partial index filters cannot be empty');

  for (const [path, condition] of Object.entries(filter)) {
    if (path === '$and' || path === '$or') {
      if (!Array.isArray(condition) || !condition.length) {
        throw new Error(`${path} requires a nonempty array`);
      }
      for (const branch of condition) checkPartialFilter(branch, paths);
      continue;
    }
    if (!paths.has(path)) throw new Error(`Unknown or unsupported partial index path: ${path}`);
    if (
      condition &&
      typeof condition === 'object' &&
      Object.keys(condition).some((key) => key.startsWith('$'))
    ) {
      record(condition, `Partial index condition at ${path}`);
      for (const [operator, operand] of Object.entries(condition)) {
        if (operator === '$exists') {
          if (operand !== true) throw new Error('Partial indexes support only $exists: true');
        } else if (operator === '$type') {
          if (!bsonTypeNames.has(operand as BsonType))
            throw new Error('Unsupported partial index BSON type alias');
        } else if (operator === '$in') {
          if (!Array.isArray(operand) || !operand.length)
            throw new Error('$in requires a nonempty array');
          for (const item of operand) checkLiteral(item);
        } else if (['$eq', '$gt', '$gte', '$lt', '$lte'].includes(operator)) {
          checkLiteral(operand);
        } else {
          throw new Error(`Unsupported partial index operator: ${operator}`);
        }
      }
    } else {
      checkLiteral(condition);
    }
  }
}

// Same five-level traversal budget as query types, counting descent through each array.
export function defineIndexes(
  fields: Fields,
  callback?: (fields: Record<string, IndexField<unknown>>) => readonly IndexDeclaration[],
): () => IndexDescription[] {
  if (!callback) return () => [];

  const scope = {};
  const refs: Record<string, IndexField<unknown>> = Object.create(null);
  function visit(field: AnyField, path: string, depth: number) {
    const definition = field.definition;
    const target = definition.kind === 'array' ? definition.element!.definition : definition;
    const ttl = !definition.codec && !target.codec && target.kind === 'date';
    refs[path] = new IndexField({ scope, path, direction: 1, ttl });
    let child = field;
    let nextDepth = depth + 1;
    while (child.definition.kind === 'array' && child.definition.element && nextDepth < 5) {
      child = child.definition.element;
      nextDepth++;
    }
    if (nextDepth >= 5 || child.definition.codec || child.definition.kind === 'map') return;
    for (const [name, nested] of Object.entries(child.definition.fields ?? {})) {
      visit(nested, `${path}.${name}`, nextDepth);
    }
  }
  for (const [path, field] of Object.entries(fields)) visit(field, path, 0);
  scopes.set(scope, new Set(Object.keys(refs)));

  // Runtime descriptors and mapped types enumerate the same bounded schema paths.
  const definitions = callback(Object.freeze(refs));
  if (!Array.isArray(definitions)) throw new Error('Index callback must return an array');
  const names = new Set<string>();
  const states = definitions.map((definition) => {
    if (!(definition instanceof IndexDefinition)) throw new Error('Expected index(name).on(...)');
    const state = definition[declaration];
    if (state.keys.some((key) => key.scope !== scope)) {
      throw new Error('Index references belong to another collection callback');
    }
    if (names.has(state.name)) throw new Error(`Duplicate index name: ${state.name}`);
    names.add(state.name);
    return state;
  });

  // Fresh native specs protect declarations from driver/caller mutation, including BSON literals.
  return () =>
    states.map((state) => {
      const entries = state.keys.map(({ path, direction }) => [path, direction] as const);
      const key = Object.fromEntries(entries);
      return {
        name: state.name,
        // Integer-looking field names are reordered by JS objects; a Map retains compound order.
        key: Object.keys(key).every((path, i) => path === entries[i]![0]) ? key : new Map(entries),
        ...(state.expireAfterSeconds !== undefined
          ? { expireAfterSeconds: state.expireAfterSeconds }
          : {}),
        ...(state.unique ? { unique: true } : {}),
        ...(state.sparse ? { sparse: true } : {}),
        ...(state.partial
          ? { partialFilterExpression: BSON.deserialize(state.partial) as Document }
          : {}),
      };
    });
}
