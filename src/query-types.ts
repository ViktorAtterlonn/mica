import type {
  AlternativeType,
  CollationOptions,
  ClientSession,
  Document,
  FilterOperators,
  Hint,
  ObjectId,
  ReadPreferenceLike,
} from 'mongodb';
import type { AnyField, Fields, InferFields } from './fields.js';

type Entry = { path: string; field: AnyField };

type Prefix<K extends string, E> = E extends Entry
  ? { path: `${K}.${E['path']}`; field: E['field'] }
  : never;

type MapEntry<F extends AnyField> = Omit<F, '$types'> & {
  readonly $types: Omit<F['$types'], 'optional'> & { optional: true };
};

type Descend<
  F extends AnyField,
  D extends unknown[],
  Arrays extends boolean,
  Maps extends boolean,
> = D['length'] extends 5
  ? never
  : F['$types']['kind'] extends 'map'
    ? Maps extends true
      ? F['$types']['element'] extends AnyField
        ? { path: string; field: MapEntry<F['$types']['element']> }
        : never
      : never
    : F['$types']['children'] extends Fields
      ? Entries<F['$types']['children'], D, Arrays, Maps>
      : Arrays extends true
        ? F['$types']['element'] extends AnyField
          ? Descend<F['$types']['element'], [...D, 0], Arrays, Maps>
          : never
        : never;

// Schema traversal is bounded, including nested arrays. Broad schemas do not recursively expand.
export type Entries<
  F extends Fields,
  D extends unknown[] = [],
  Arrays extends boolean = true,
  Maps extends boolean = true,
> = string extends keyof F
  ? Entry
  : D['length'] extends 5
    ? never
    : {
        [K in keyof F & string]:
          | { path: K; field: F[K] }
          | Prefix<K, Descend<F[K], [...D, 0], Arrays, Maps>>;
      }[keyof F & string];

type ContainsCodec<F extends AnyField> = F['$types']['codec'] extends false
  ? F['$types']['children'] extends Fields
    ? true extends {
        [K in keyof F['$types']['children']]: ContainsCodec<F['$types']['children'][K]>;
      }[keyof F['$types']['children']]
      ? true
      : false
    : F['$types']['element'] extends AnyField
      ? ContainsCodec<F['$types']['element']>
      : false
  : true;

type DistinctEntries<F extends Fields, E = Entries<F>> = E extends Entry
  ? ContainsCodec<E['field']> extends false
    ? E
    : never
  : never;

export type DistinctPath<F extends Fields> = string extends keyof F
  ? string
  : DistinctEntries<F>['path'];

type EntryAt<E, P> = E extends Entry ? (P extends E['path'] ? E : never) : never;

type DistinctElement<V> = V extends (infer E)[] ? E : V;

/** MongoDB expands the selected array by one level; missing fields contribute no value. */
export type DistinctValue<F extends Fields, P extends string> = string extends keyof F
  ? unknown
  : DistinctElement<EntryAt<Entries<F>, P>['field']['$types']['app']>;

type BasicOperators<V> = Pick<
  FilterOperators<AlternativeType<V>>,
  '$eq' | '$ne' | '$gt' | '$gte' | '$lt' | '$lte' | '$in' | '$nin' | '$exists' | '$type'
>;

type RegexOperators<V> =
  Extract<AlternativeType<V>, string> extends never
    ? {}
    : { $regex?: string | RegExp; $options?: string };

type Condition<V> =
  | AlternativeType<V>
  | (BasicOperators<V> &
      RegexOperators<V> & {
        $not?:
          | (BasicOperators<V> & RegexOperators<V>)
          | (Extract<AlternativeType<V>, string> extends never ? never : RegExp);
      });

type FieldOperators<F extends AnyField> = BasicOperators<F['$types']['app']> &
  RegexOperators<F['$types']['app']> & {
    $not?:
      | FieldOperators<F>
      | (Extract<AlternativeType<F['$types']['app']>, string> extends never ? never : RegExp);
  } & (F['$types']['kind'] extends 'array'
    ? F['$types']['element'] extends AnyField
      ? {
          $size?: number;
          $all?: AlternativeType<F['$types']['element']['$types']['app']>[];
          $elemMatch?: F['$types']['element']['$types']['children'] extends Fields
            ? Filter<F['$types']['element']['$types']['children']>
            : FieldOperators<F['$types']['element']>;
        }
      : {}
    : {});

export type ArrayElementFilter<F extends AnyField> = F['$types']['element'] extends AnyField
  ? F['$types']['element']['$types']['children'] extends Fields
    ? Filter<F['$types']['element']['$types']['children']>
    :
        | AlternativeType<F['$types']['element']['$types']['app']>
        | FieldOperators<F['$types']['element']>
  : never;

// Carry the same entries through logical branches to avoid repeatedly expanding
// recursive schema paths when a pretyped filter is passed to a generic query.
export type Filter<F extends Fields, E extends Entry = Entries<F>> = {
  [P in E as P['path']]?: AlternativeType<P['field']['$types']['app']> | FieldOperators<P['field']>;
} & { $and?: Filter<F, E>[]; $or?: Filter<F, E>[]; $nor?: Filter<F, E>[] };

type Protected<F extends AnyField> = F['$types']['immutable'] extends true
  ? true
  : F['$types']['generated'];

// Inspect all descendants, even below the dot-path budget: replacing a parent
// would overwrite them. Appending new array elements is still an insertion.
type ContainsProtected<F extends AnyField> =
  Protected<F> extends true
    ? true
    : F['$types']['children'] extends Fields
      ? true extends {
          [K in keyof F['$types']['children']]: ContainsProtected<F['$types']['children'][K]>;
        }[keyof F['$types']['children']]
        ? true
        : false
      : F['$types']['element'] extends AnyField
        ? ContainsProtected<F['$types']['element']>
        : false;

type ArraySelector = `${number}` | '$' | '$[]' | `$[${string}]`;
type WriteDescend<F extends AnyField, D extends unknown[]> = D['length'] extends 5
  ? never
  : F['$types']['kind'] extends 'map'
    ? F['$types']['element'] extends AnyField
      ? Protected<F['$types']['element']> extends true
        ? never
        : { path: string; field: MapEntry<F['$types']['element']> }
      : never
    : F['$types']['children'] extends Fields
      ? WriteEntries<F['$types']['children'], D>
      : F['$types']['element'] extends AnyField
        ? Protected<F['$types']['element']> extends true
          ? never
          :
              | { path: ArraySelector; field: F['$types']['element'] }
              | Prefix<ArraySelector, WriteDescend<F['$types']['element'], [...D, 0]>>
        : never;
type WriteEntries<F extends Fields, D extends unknown[] = []> = string extends keyof F
  ? Entry
  : D['length'] extends 5
    ? never
    : {
        [K in keyof F & string]: Protected<F[K]> extends true
          ? never
          : { path: K; field: F[K] } | Prefix<K, WriteDescend<F[K], [...D, 0]>>;
      }[keyof F & string];

type Writable<E extends Entry> = E extends Entry ? (E['path'] extends '_id' ? never : E) : never;

type PushValue<F extends AnyField> = F['$types']['element'] extends AnyField
  ? F['$types']['element']['$types']['insert']
  : never;

type PushModifiers<F extends AnyField> = F extends unknown
  ? {
      $each: PushValue<F>[];
      $position?: number;
      $slice?: ContainsProtected<F> extends true ? never : number;
      $sort?: F['$types']['element'] extends AnyField
        ? F['$types']['element']['$types']['children'] extends Fields
          ? Partial<Record<Entries<F['$types']['element']['$types']['children']>['path'], 1 | -1>>
          : ContainsCodec<F> extends false
            ? 1 | -1
            : never
        : never;
    }
  : never;

type ScalarArray<F extends AnyField> = F['$types']['kind'] extends 'array'
  ? F['$types']['element'] extends AnyField
    ? F['$types']['element']['$types']['kind'] extends 'object' | 'array' | 'map' | 'custom'
      ? false
      : ContainsCodec<F> extends false
        ? true
        : false
    : false
  : false;

type PullArray<F extends AnyField> = F['$types']['kind'] extends 'array'
  ? F['$types']['element'] extends AnyField
    ? F['$types']['element']['$types']['codec'] extends false
      ? F['$types']['element']['$types']['children'] extends Fields
        ? true
        : ScalarArray<F>
      : false
    : false
  : false;

type PullValue<F extends AnyField> = F['$types']['element'] extends AnyField
  ? F['$types']['element']['$types']['children'] extends Fields
    ? Filter<F['$types']['element']['$types']['children']>
    : Condition<F['$types']['element']['$types']['app']>
  : never;

type NonemptyValues<T> = keyof T extends never ? Record<string, never> : T;

type CompareValues<E extends Entry> = NonemptyValues<{
  [
    P in E as P['field']['$types']['kind'] extends 'number' | 'date'
      ? P['field']['$types']['codec'] extends false
        ? P['path']
        : never
      : never
  ]?: Exclude<P['field']['$types']['app'], null>;
}>;

export type Update<
  F extends Fields,
  E extends Entry = Writable<WriteEntries<F>>,
> = string extends keyof F
  ? {
      $set?: Record<string, unknown>;
      $push?: Record<string, unknown>;
      $unset?: Record<string, unknown>;
      $inc?: Record<string, unknown>;
      $min?: Record<string, unknown>;
      $max?: Record<string, unknown>;
      $addToSet?: Record<string, unknown>;
      $pull?: Record<string, unknown>;
    }
  : {
      $min?: CompareValues<E>;
      $max?: CompareValues<E>;
      $set?: NonemptyValues<{
        [
          P in E as ContainsProtected<P['field']> extends true ? never : P['path']
        ]?: P['field']['$types']['insert'];
      }>;
      $unset?: NonemptyValues<{
        [
          P in E as P['field']['$types']['optional'] extends true
            ? ContainsProtected<P['field']> extends true
              ? never
              : P['path']
            : never
        ]?: '' | true | 1;
      }>;
      $inc?: NonemptyValues<{
        [
          P in E as P['field']['$types']['kind'] extends 'number'
            ? P['field']['$types']['codec'] extends false
              ? P['path']
              : never
            : never
        ]?: number;
      }>;
      $addToSet?: NonemptyValues<{
        [P in E as ScalarArray<P['field']> extends true ? P['path'] : never]?:
          | PushValue<P['field']>
          | { $each: PushValue<P['field']>[] };
      }>;
      $pull?: NonemptyValues<{
        [
          P in E as PullArray<P['field']> extends true
            ? ContainsProtected<P['field']> extends true
              ? never
              : P['path']
            : never
        ]?: PullValue<P['field']>;
      }>;
      $push?: NonemptyValues<{
        [P in E as P['field']['$types']['kind'] extends 'array' ? P['path'] : never]?:
          | PushValue<P['field']>
          | PushModifiers<P['field']>;
      }>;
    };

export type UpsertUpdate<F extends Fields> = {
  $inc?: Update<F>['$inc'];
  $set?: Update<F>['$set'];
  $setOnInsert?: Partial<InferFields<F, 'insert'>>;
};
export type UpsertOptions = Omit<UpdateOptions, 'upsert' | 'arrayFilters'> & { upsert: true };
export type WriteMetadata<T> = {
  value: T | null;
  ok: number;
  lastErrorObject?: { updatedExisting?: boolean; upserted?: unknown; n?: number };
};

export type Projection<F extends Fields> = Partial<Record<Entries<F>['path'], 0 | 1>>;

type KeysWith<P, V> = { [K in keyof P]: P[K] extends V ? K : never }[keyof P];

type NonLiteralKeys<P> = {
  [K in keyof P]-?: P[K] extends 0 ? never : P[K] extends 1 ? never : K;
}[keyof P];

export type ValidProjection<F extends Fields, P> =
  NonLiteralKeys<P> extends never
    ? Exclude<keyof P, Entries<F>['path']> extends never
      ? Exclude<KeysWith<P, 1>, '_id'> extends never
        ? unknown
        : Exclude<KeysWith<P, 0>, '_id'> extends never
          ? unknown
          : never
      : never
    : never;

type ChildPaths<P extends string, K extends string> = P extends `${K}.${infer Rest}` ? Rest : never;
type PickPaths<T, P extends string> = string extends keyof T
  ? { [K in P]?: T[string & keyof T] }
  : T extends (infer E)[]
    ? PickPaths<E, P>[]
    : T extends object
      ? {
          [
            K in keyof T as K extends string
              ? Extract<P, K | `${K}.${string}`> extends never
                ? never
                : K
              : never
          ]: K extends P ? T[K] : K extends string ? PickPaths<T[K], ChildPaths<P, K>> : never;
        }
      : T;
type OmitPaths<T, P extends string> = string extends keyof T
  ? T & Partial<Record<P, never>>
  : T extends (infer E)[]
    ? OmitPaths<E, P>[]
    : T extends object
      ? {
          [K in keyof T as K extends P ? never : K]: K extends string
            ? [ChildPaths<P, K>] extends [never]
              ? T[K]
              : OmitPaths<T[K], ChildPaths<P, K>>
            : T[K];
        }
      : T;

export type Project<T, P> = P extends undefined
  ? T
  : keyof P extends never
    ? T
    : Exclude<KeysWith<P, 1>, '_id'> extends never
      ? KeysWith<P, 0> extends never
        ? PickPaths<T, Extract<KeysWith<P, 1>, string>>
        : OmitPaths<T, Extract<KeysWith<P, 0>, string>>
      : PickPaths<T, Extract<KeysWith<P, 1>, string> | (P extends { _id: 0 } ? never : '_id')>;

export type SelectResult<F extends Fields, P> = Project<InferFields<F, 'app'>, P>;

/** Object insertion order or explicit ordered pairs; directions are BSON sort directions. */
export type Sort<F extends Fields> =
  | Partial<Record<Entries<F>['path'], 1 | -1>>
  | readonly (readonly [Entries<F>['path'], 1 | -1])[];

export type ExecutionOptions = {
  /** Client-side operation budget. Zero disables the operation timeout. */
  timeoutMS?: number;
  /** Server-side processing limit. Zero disables the server limit. */
  maxTimeMS?: number;
  signal?: AbortSignal;
};
export type SessionOptions = ExecutionOptions & { session?: ClientSession };
export type OperationOptions = SessionOptions & { collation?: CollationOptions; hint?: Hint };
export type QueryOptions = OperationOptions & { readPreference?: ReadPreferenceLike };

export type ReadOptions<F extends Fields, P> = QueryOptions & {
  projection?: P & ValidProjection<F, P>;
  sort?: Sort<F>;
};

export type FindOptions<F extends Fields, P> = ReadOptions<F, P> & {
  skip?: number;
  limit?: number;
  batchSize?: number;
};

export type IdValue<F extends Fields> = F extends { _id: AnyField }
  ? F['_id']['$types']['app']
  : ObjectId;

export type ChunkOptions<F extends Fields, P> = QueryOptions & {
  size: number;
  projection?: P & ValidProjection<F, P>;
  afterId?: IdValue<F>;
};

export type CountOptions = QueryOptions & { skip?: number; limit?: number };
export type BatchOptions = SessionOptions & { ordered?: boolean };
export type UpdateOptions = OperationOptions & {
  upsert?: false;
  timestamps?: boolean;
  arrayFilters?: readonly Document[];
};
export type FindOneAndUpdateOptions<F extends Fields, P> = Omit<
  ReadOptions<F, P>,
  'readPreference'
> &
  UpdateOptions & {
    returnDocument?: 'before' | 'after';
  };

type BulkUpdate<F extends Fields> = Omit<OperationOptions, keyof SessionOptions> & {
  filter: Filter<F>;
  timestamps?: boolean;
} & (
    | { update: Update<F>; upsert?: false; arrayFilters?: readonly Document[] }
    | { update: UpsertUpdate<F>; upsert: true }
  );
type BulkOperations<F extends Fields> = {
  insertOne: { document: InferFields<F, 'insert'> };
  updateOne: BulkUpdate<F>;
  updateMany: BulkUpdate<F>;
  deleteOne: Omit<OperationOptions, keyof SessionOptions> & { filter: Filter<F> };
  deleteMany: Omit<OperationOptions, keyof SessionOptions> & { filter: Filter<F> };
};

/** Exactly one supported operation per entry, including for pretyped variables. */
export type BulkOperation<F extends Fields> = {
  [K in keyof BulkOperations<F>]: Pick<BulkOperations<F>, K> &
    Partial<Record<Exclude<keyof BulkOperations<F>, K>, never>>;
}[keyof BulkOperations<F>];
