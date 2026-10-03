import { ObjectId, type AlternativeType, type Document, type FilterOperators } from 'mongodb';
import type { AnyField, Fields, InferFields } from './fields.js';
import type { Entries } from './query-types.js';
import { resolvePath } from './schema-paths.js';
import { MicaValidationError } from './errors.js';
import { prepareFilter } from './query-options.js';

type MatchValue<F extends AnyField> = F['$types']['codec'] extends false
  ? F['$types']['kind'] extends 'objectId'
    ? F['$types']['app'] | string
    : F['$types']['children'] extends Fields
      ? InferFields<MatchFields<F['$types']['children']>, 'app'> | Extract<F['$types']['app'], null>
      : F['$types']['element'] extends AnyField
        ?
            | (F['$types']['kind'] extends 'map'
                ? Record<string, MatchValue<F['$types']['element']>>
                : MatchValue<F['$types']['element']>[])
            | Extract<F['$types']['app'], null>
        : F['$types']['app']
  : F['$types']['app'];

type MatchField<F extends AnyField> = {
  readonly definition: F['definition'];
  readonly $types: Omit<F['$types'], 'app' | 'children' | 'element'> & {
    app: MatchValue<F>;
    children: F['$types']['children'] extends Fields
      ? MatchFields<F['$types']['children']>
      : F['$types']['children'];
    element: F['$types']['element'] extends AnyField
      ? MatchField<F['$types']['element']>
      : F['$types']['element'];
  };
};

type MatchFields<F extends Fields> = { [K in keyof F]: MatchField<F[K]> };

type MatchOperand<F extends AnyField> =
  | MatchValue<F>
  | (F['$types']['kind'] extends 'array'
      ? F['$types']['element'] extends AnyField
        ? MatchValue<F['$types']['element']>
        : never
      : never)
  | Extract<AlternativeType<F['$types']['app']>, RegExp>;

type MatchOperators<F extends AnyField> = Pick<
  FilterOperators<MatchOperand<F>>,
  '$eq' | '$ne' | '$gt' | '$gte' | '$lt' | '$lte' | '$in' | '$nin' | '$exists' | '$type'
> &
  (Extract<AlternativeType<F['$types']['app']>, string> extends never
    ? {}
    : { $regex?: string | RegExp; $options?: string }) & {
    $not?: MatchOperators<F> | Extract<AlternativeType<F['$types']['app']>, RegExp>;
  } & (F['$types']['kind'] extends 'array'
    ? F['$types']['element'] extends AnyField
      ? {
          $size?: number;
          $all?: MatchOperand<F['$types']['element']>[];
          $elemMatch?: F['$types']['element']['$types']['children'] extends Fields
            ? AggregateFilter<F['$types']['element']['$types']['children']>
            : MatchOperators<F['$types']['element']>;
        }
      : {}
    : {});

/** Only aggregation match inputs accept ObjectId strings; output types remain unchanged. */
export type AggregateFilter<F extends Fields> = {
  [E in Entries<F> as E['path']]?: MatchOperand<E['field']> | MatchOperators<E['field']>;
} & { $and?: AggregateFilter<F>[]; $or?: AggregateFilter<F>[]; $nor?: AggregateFilter<F>[] };

function isRecord(value: unknown): value is Document {
  return (
    !!value &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function literal(field: AnyField, value: unknown, path: string): unknown {
  const definition = field.definition;
  if (value === null || definition.codec) return value;
  if (definition.kind === 'objectId' && typeof value === 'string') {
    if (!/^[a-fA-F0-9]{24}$/.test(value)) {
      throw new MicaValidationError(
        'invalid_value',
        path,
        `${path}: expected a 24-character hexadecimal ObjectId string`,
      );
    }
    return new ObjectId(value);
  }
  if (definition.kind === 'array' && definition.element) {
    // MongoDB supports both whole-array equality and implicit element membership.
    return Array.isArray(value)
      ? value.map((item, index) => literal(definition.element!, item, `${path}.${index}`))
      : literal(definition.element, value, path);
  }
  if (isRecord(value)) {
    if (definition.fields) {
      const fields = definition.fields;
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          Object.hasOwn(fields, key) ? literal(fields[key]!, item, `${path}.${key}`) : item,
        ]),
      );
    }
    if (definition.kind === 'map' && definition.element) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          literal(definition.element!, item, `${path}.${key}`),
        ]),
      );
    }
  }
  return value;
}

function condition(field: AnyField, value: unknown, path: string): unknown {
  if (!isRecord(value) || !Object.keys(value).some((key) => key.startsWith('$'))) {
    return literal(field, value, path);
  }
  return Object.fromEntries(
    Object.entries(value).map(([operator, operand]) => {
      let converted = operand;
      if (['$eq', '$ne', '$gt', '$gte', '$lt', '$lte'].includes(operator)) {
        converted = literal(field, operand, path);
      } else if (operator === '$in' || operator === '$nin') {
        converted = (operand as unknown[]).map((item) => literal(field, item, path));
      } else if (operator === '$all') {
        converted = (operand as unknown[]).map((item) =>
          literal(field.definition.element!, item, path),
        );
      } else if (operator === '$not') {
        converted = condition(field, operand, path);
      } else if (operator === '$elemMatch') {
        const element = field.definition.element!;
        converted =
          element.definition.fields && !element.definition.codec
            ? filter(element.definition.fields, operand, path)
            : condition(element, operand, path);
      }
      // Control operands such as $type, $exists and $size are not field values.
      return [operator, converted];
    }),
  );
}

function filter(fields: Fields, input: Document, prefix = ''): Document {
  return Object.fromEntries(
    Object.entries(input).map(([path, value]) => [
      path,
      ['$and', '$or', '$nor'].includes(path)
        ? (value as Document[]).map((child) => filter(fields, child, prefix))
        : condition(resolvePath(fields, path, true), value, prefix ? `${prefix}.${path}` : path),
    ]),
  );
}

export function prepareAggregateFilter(fields: Fields, input: unknown): Document {
  // Validate all operators/paths and codec restrictions, then work on an owned BSON snapshot.
  return filter(fields, prepareFilter(fields, input));
}
