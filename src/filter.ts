import type { Document } from 'mongodb';
import type { AnyField, Fields } from './fields.js';
import { hasCodec, resolvePath } from './schema-paths.js';
import { bsonTypeNames, fail, record } from './validation.js';

const comparisonOps = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin']);

function checkCondition(field: AnyField, condition: unknown, path: string) {
  // Scalar $pull predicates also use this boundary without a surrounding filter document.
  checkFilterValues(condition, path);
  const operators =
    condition &&
    typeof condition === 'object' &&
    !Array.isArray(condition) &&
    Object.keys(condition).some((key) => key.startsWith('$'))
      ? (condition as Document)
      : undefined;
  const codec = hasCodec(field);
  const noCodec = () => {
    if (codec)
      fail(
        path,
        'value filters on codec-backed fields/ancestors are unsupported; only structural predicates are safe',
      );
  };
  if (!operators) {
    noCodec();
    return;
  }
  record(operators, path);
  for (const [op, value] of Object.entries(operators)) {
    if (op === '$exists') {
      if (typeof value !== 'boolean') fail(path, '$exists requires boolean');
      continue;
    }

    if (op === '$not') {
      if (!(value instanceof RegExp)) {
        record(value, path);
        if (!Object.keys(value).length || !Object.keys(value).every((key) => key.startsWith('$')))
          fail(path, '$not requires operators or a regular expression');
      }
      checkCondition(field, value, path);
      continue;
    }

    if (op === '$elemMatch') {
      const element = field.definition.element;
      if (!element || field.definition.kind !== 'array' || field.definition.codec)
        fail(path, '$elemMatch requires an array');
      record(value, path);
      if (element.definition.fields && !element.definition.codec) {
        checkFilter(element.definition.fields, value);
        continue;
      }
      if (Object.keys(value).some((key) => !key.startsWith('$')))
        fail(path, '$elemMatch on scalars requires operators');
      checkCondition(element, value, path);
      continue;
    }

    if (op === '$size') {
      if (
        field.definition.kind !== 'array' ||
        field.definition.codec ||
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 0
      )
        fail(path, '$size requires an array field and a nonnegative integer');
      continue;
    }

    if (op === '$all') {
      noCodec();
      if (field.definition.kind !== 'array' || !Array.isArray(value))
        fail(path, '$all requires an array field and array operand');
      // Predicate-form $all is separate from literal element membership.
      if (
        value.some(
          (item) =>
            item &&
            typeof item === 'object' &&
            Object.keys(item).some((key) => key.startsWith('$')),
        )
      )
        fail(path, '$all supports literal elements; use $elemMatch for predicates');
      continue;
    }

    if (op === '$regex' || op === '$options') {
      noCodec();
      let scalar = field;
      while (scalar.definition.kind === 'array' && scalar.definition.element)
        scalar = scalar.definition.element;
      if (scalar.definition.kind !== 'string') fail(path, '$regex requires a string field');
      if (op === '$regex' && typeof value !== 'string' && !(value instanceof RegExp))
        fail(path, '$regex requires a string or regular expression');
      if (
        op === '$options' &&
        (operators.$regex === undefined ||
          typeof value !== 'string' ||
          !/^[imsxu]*$/.test(value) ||
          new Set(value).size !== value.length)
      )
        fail(path, '$options requires $regex and valid distinct flags');
      continue;
    }

    if (op === '$type') {
      noCodec();
      const types = Array.isArray(value) ? value : [value];
      if (
        !types.length ||
        types.some((type) =>
          typeof type === 'string'
            ? !bsonTypeNames.has(type)
            : !Number.isInteger(type) ||
              !(type === -1 || type === 127 || (type >= 1 && type <= 19)),
        )
      )
        fail(path, '$type requires valid BSON types');
      continue;
    }

    if (comparisonOps.has(op)) {
      noCodec();
      if ((op === '$in' || op === '$nin') && !Array.isArray(value))
        fail(path, `${op} requires array`);
      continue;
    }

    fail(path, `unsupported filter operator ${op}`);
  }
}

function checkFilterValues(value: unknown, path: string, ancestors = new Set<object>()) {
  if (value === undefined)
    fail(path, 'undefined filter values are unsupported; omit the predicate explicitly');
  if (value === null || typeof value !== 'object') return;
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return;
  if (ancestors.has(value)) fail(path, 'cyclic filter values are unsupported');
  ancestors.add(value);
  const entries = Array.isArray(value)
    ? Array.from(value, (item, index) => [String(index), item] as const)
    : Object.entries(value);
  for (const [key, child] of entries)
    checkFilterValues(child, path ? `${path}.${key}` : key, ancestors);
  ancestors.delete(value);
}

export function checkFilter(fields: Fields, filter: unknown): asserts filter is Document {
  record(filter, 'filter');
  checkFilterValues(filter, '');
  for (const [path, condition] of Object.entries(filter)) {
    if (['$and', '$or', '$nor'].includes(path)) {
      if (!Array.isArray(condition) || !condition.length)
        fail(path, 'expected nonempty filter array');
      for (const child of condition) checkFilter(fields, child);
    } else {
      checkCondition(resolvePath(fields, path, true), condition, path);
    }
  }
}
