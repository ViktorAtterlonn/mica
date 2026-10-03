import type { AnyField, Field, Fields, InferFields } from './fields.js';
import type { Entries, QueryOptions, SelectResult, Sort, ValidProjection } from './query-types.js';
import type { AggregateFilter } from './aggregate-filter.js';

export type AggregateOptions = QueryOptions & { allowDiskUse?: boolean; batchSize?: number };

type ProjectionPath<F extends Fields> = Entries<F, [], true, false>['path'];
type AggregateProjection<F extends Fields> = Partial<Record<ProjectionPath<F>, 0 | 1>>;

// Keep the original field identity (including codecs and atomic custom values)
// while narrowing its children and application value after a projection.
type ProjectedField<F extends AnyField, V, O extends boolean> = {
  readonly definition: F['definition'];
  readonly $types: Omit<F['$types'], 'app' | 'children' | 'element' | 'optional'> & {
    app: V;
    optional: O;
    children: F['$types']['children'] extends Fields
      ? ProjectedFields<F['$types']['children'], NonNullable<V>>
      : F['$types']['children'];
    element: F['$types']['element'] extends AnyField
      ? NonNullable<V> extends (infer E)[]
        ? ProjectedField<F['$types']['element'], E, false>
        : F['$types']['element']
      : F['$types']['element'];
  };
};

type ProjectedFields<F extends Fields, T> = {
  [K in keyof T & keyof F]: ProjectedField<
    F[K],
    Exclude<T[K], undefined>,
    {} extends Pick<T, K> ? true : false
  >;
};

type ScalarEntry<F extends Fields, E = Entries<F, [], false, false>> = E extends {
  path: string;
  field: AnyField;
}
  ? E['field']['$types']['codec'] extends false
    ? E['field']['$types']['kind'] extends
        | 'string'
        | 'number'
        | 'boolean'
        | 'date'
        | 'objectId'
        | 'binary'
      ? E
      : never
    : never
  : never;

type NumericEntry<F extends Fields, E = ScalarEntry<F>> = E extends {
  path: string;
  field: AnyField;
}
  ? E['field']['$types']['kind'] extends 'number'
    ? E
    : never
  : never;

export type AggregateReference<F extends Fields> = `$${ScalarEntry<F>['path']}`;
type NumericReference<F extends Fields> = `$${NumericEntry<F>['path']}`;

type AccumulatorOperands<F extends Fields> = {
  $sum: NumericReference<F> | number;
  $avg: NumericReference<F>;
  $min: NumericReference<F>;
  $max: NumericReference<F>;
};

export type AggregateAccumulator<F extends Fields> = {
  [K in keyof AccumulatorOperands<F>]: Pick<AccumulatorOperands<F>, K> &
    Partial<Record<Exclude<keyof AccumulatorOperands<F>, K>, never>>;
}[keyof AccumulatorOperands<F>];

type GroupSpec<F extends Fields> = {
  _id: AggregateReference<F> | null;
} & Record<string, AggregateReference<F> | null | AggregateAccumulator<F>>;

type ValidGroup<F extends Fields, G> = {
  [K in keyof G]: K extends '_id'
    ? AggregateReference<F> | null
    : K extends
          | ''
          | `$${string}`
          | `${string}.${string}`
          | '__proto__'
          | 'constructor'
          | 'prototype'
      ? never
      : AggregateAccumulator<F>;
};

type PathValue<T, P extends string> = T extends null | undefined
  ? null
  : P extends `${infer K}.${infer Rest}`
    ? K extends keyof T
      ? PathValue<T[K], Rest>
      : never
    : P extends keyof T
      ? Exclude<T[P], undefined> | (undefined extends T[P] ? null : never)
      : never;

type ReferenceField<F extends Fields, R, E = ScalarEntry<F>> = E extends {
  path: string;
  field: AnyField;
}
  ? R extends `$${E['path']}`
    ? ProjectedField<E['field'], PathValue<InferFields<F, 'app'>, E['path']>, false>
    : never
  : never;

type GroupKeyField<F extends Fields, R> = R extends null
  ? Field<null, null, null, 'custom'>
  : ReferenceField<F, R>;

type GroupFields<F extends Fields, G> = {
  [K in keyof G]: K extends '_id'
    ? GroupKeyField<F, G[K]>
    : G[K] extends { $sum: unknown }
      ? Field<number, number, number, 'number'>
      : Field<number | null, number | null, number | null, 'number'>;
};

type IsUnion<T, All = T> = T extends All ? ([All] extends [T] ? false : true) : never;

/** An immutable, read-only pipeline. Execution is explicit and returns decoded plain objects. */
export interface Aggregation<F extends Fields> {
  match(filter: AggregateFilter<F>): Aggregation<F>;
  project<const P extends AggregateProjection<F>>(
    projection: P &
      ValidProjection<F, P> &
      (Exclude<keyof P, ProjectionPath<F>> extends never ? unknown : never),
  ): Aggregation<ProjectedFields<F, SelectResult<F, P>>>;
  group<const G extends GroupSpec<F>>(
    specification: G & ValidGroup<F, G>,
  ): Aggregation<GroupFields<F, G>>;
  sort(sort: Sort<F>): Aggregation<F>;
  skip(count: number): Aggregation<F>;
  limit(count: number): Aggregation<F>;
  count<const K extends string>(
    field: K &
      (string extends K
        ? never
        : true extends IsUnion<K>
          ? never
          : K extends
                | ''
                | '_id'
                | `$${string}`
                | `${string}.${string}`
                | '__proto__'
                | 'constructor'
                | 'prototype'
            ? never
            : unknown),
  ): Aggregation<{ [P in K]: Field<number, number, number, 'number'> }>;
  toArray(): Promise<InferFields<F, 'select'>[]>;
}
