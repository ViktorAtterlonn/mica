import { BSON, type Document } from 'mongodb';
import type { AnyField, Fields } from './fields.js';
import { MicaValidationError } from './errors.js';
import { encodeValue } from './codec.js';
import { checkFilter } from './filter.js';
import { hasCodec, containsProtected, resolvePath, resolveWritePath } from './schema-paths.js';
import { fail, record } from './validation.js';

function checkWritable(path: string, field: AnyField, operator: string) {
  if (['$set', '$unset', '$pull'].includes(operator) && containsProtected(field)) {
    fail(path, 'replacement or removal would overwrite immutable descendants', 'immutable_field');
  }
}

function conflictingPaths(left: string, right: string): boolean {
  const a = left.split('.');
  const b = right.split('.');
  return a
    .slice(0, Math.min(a.length, b.length))
    .every(
      (part, i) =>
        part === b[i] ||
        (part.startsWith('$') && (/^[0-9]+$/.test(b[i]!) || b[i]!.startsWith('$'))) ||
        (b[i]!.startsWith('$') && /^[0-9]+$/.test(part)),
    );
}

/** Bind native array-filter identifiers to the schema reached by the update path. */
export function prepareArrayFilters(
  fields: Fields,
  update: unknown,
  input: unknown,
): Document[] | undefined {
  record(update, 'update');
  const bindings = new Map<string, AnyField>();
  for (const values of Object.values(update)) {
    record(values, 'update operands');
    for (const path of Object.keys(values)) resolveWritePath(fields, path, bindings);
  }
  if (input === undefined) {
    if (bindings.size)
      throw new MicaValidationError(
        'invalid_option',
        'arrayFilters',
        'Missing arrayFilters for filtered positional update',
      );
    return undefined;
  }
  if (!Array.isArray(input))
    throw new MicaValidationError(
      'invalid_option',
      'arrayFilters',
      'arrayFilters requires an array',
    );
  const seen = new Set<string>();
  const output = Array.from(input, (filter) => {
    const names = new Set<string>();
    function visit(value: unknown) {
      record(value, 'array filter');
      for (const [key, condition] of Object.entries(value)) {
        if (['$and', '$or', '$nor'].includes(key)) {
          if (!Array.isArray(condition))
            throw new MicaValidationError(
              'invalid_option',
              'arrayFilters',
              'Array filter logical branches require arrays',
            );
          condition.forEach(visit);
        } else names.add(key.split('.')[0]!);
      }
    }
    visit(filter);
    if (names.size !== 1)
      throw new MicaValidationError(
        'invalid_option',
        'arrayFilters',
        'Each array filter must refer to exactly one identifier',
      );
    const name = [...names][0]!;
    const element = bindings.get(name);
    if (!element || seen.has(name))
      throw new MicaValidationError(
        'invalid_option',
        'arrayFilters',
        'Unused or duplicate array filter identifier',
      );
    seen.add(name);
    checkFilter({ [name]: element }, filter);
    return BSON.deserialize(BSON.serialize(filter as Document));
  });
  if (seen.size !== bindings.size)
    throw new MicaValidationError(
      'invalid_option',
      'arrayFilters',
      'Missing array filter identifier',
    );
  return output;
}

export function encodeUpdate(
  fields: Fields,
  update: unknown,
  now: Date,
  timestamps = true,
  encodedSet?: Document,
): Document {
  record(update, 'update');
  const output: Document = {};
  const paths: string[] = [];

  for (const [operator, values] of Object.entries(update)) {
    if (
      !['$set', '$push', '$unset', '$inc', '$addToSet', '$pull', '$min', '$max'].includes(operator)
    ) {
      fail(operator, 'unsupported update operator', 'unsupported_operation');
    }

    record(values, operator);
    const encoded: Document = {};

    for (const [path, value] of Object.entries(values)) {
      const field = resolveWritePath(fields, path);

      checkWritable(path, field, operator);

      if (paths.some((p) => conflictingPaths(path, p))) {
        fail(path, 'conflicting update paths', 'conflicting_paths');
      }

      paths.push(path);

      encoded[path] = encodeOperand(operator, field, value, path, now, encodedSet);
    }

    if (Object.keys(encoded).length) {
      output[operator] = encoded;
    }
  }

  if (!paths.length) {
    throw new MicaValidationError('invalid_update', 'update', 'Empty updates are unsupported');
  }

  for (const [key, field] of Object.entries(fields)) {
    if (timestamps && field.definition.generated === 'updatedAt') {
      (output.$set ??= {})[key] = new Date(now);
    }
  }

  return output;
}

function encodeOperand(
  operator: string,
  field: AnyField,
  value: unknown,
  path: string,
  now: Date,
  encodedSet?: Document,
): unknown {
  if (operator === '$set') {
    // Upserts reuse values already validated/encoded as a complete insertion.
    if (encodedSet && Object.hasOwn(encodedSet, path)) return encodedSet[path];
    return encodeValue(field, value, path, now);
  }

  if (operator === '$min' || operator === '$max') {
    if (
      !['number', 'date'].includes(field.definition.kind) ||
      field.definition.codec ||
      value === null
    ) {
      fail(path, `${operator} requires a non-null number or date without a codec`);
    }
    return encodeValue(field, value, path, now);
  }

  if (operator === '$unset') {
    if (!field.definition.optional) fail(path, '$unset requires an optional field');
    if (value !== '' && value !== true && value !== 1) {
      fail(path, '$unset requires an empty string, true, or 1');
    }
    // Removing a field never invokes its codec or reinstates its default.
    return value;
  }

  if (operator === '$inc') {
    if (field.definition.kind !== 'number' || field.definition.codec) {
      fail(path, '$inc requires a number field without a codec');
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail(path, '$inc requires a finite numeric delta');
    }
    if (field.definition.integer && !Number.isInteger(value)) {
      fail(path, '$inc requires an integer delta for integer fields');
    }
    // Bounds constrain the result; MongoDB validates it without a read-modify-write.
    return value;
  }

  return encodeArrayOperand(operator, field, value, path, now);
}

function encodeArrayOperand(
  operator: string,
  field: AnyField,
  value: unknown,
  path: string,
  now: Date,
): unknown {
  const element = field.definition.element;
  if (!element || field.definition.kind !== 'array' || field.definition.codec) {
    fail(path, `${operator} requires a non-codec array container`);
  }

  if (operator === '$pull' && element.definition.fields && !element.definition.codec) {
    // Match stored fields without encoding the predicate or requiring a full element.
    checkFilter(element.definition.fields, value);
    return value;
  }

  if (operator === '$addToSet' || operator === '$pull') {
    if (
      hasCodec(element) ||
      ['object', 'array', 'map', 'custom'].includes(element.definition.kind)
    ) {
      fail(path, `${operator} currently requires scalar array elements without codecs`);
    }
  }

  if (operator === '$pull') {
    checkFilter({ value: element }, { value });
    if (value === undefined) fail(path, '$pull requires a value or predicate');
    return value;
  }

  if (!value || typeof value !== 'object' || !Object.hasOwn(value, '$each')) {
    return encodeValue(element, value, path, now);
  }

  record(value, path);
  const allowed = operator === '$push' ? ['$each', '$slice', '$position', '$sort'] : ['$each'];
  if (Object.keys(value).some((key) => !allowed.includes(key)) || !Array.isArray(value.$each)) {
    fail(path, `${operator}: unsupported array modifier or invalid $each`);
  }
  for (const key of ['$slice', '$position']) {
    if (Object.hasOwn(value, key) && !Number.isSafeInteger(value[key])) {
      fail(path, `${key} requires a safe integer`);
    }
  }
  if (Object.hasOwn(value, '$slice') && containsProtected(field)) {
    fail(path, '$slice would remove immutable descendants', 'immutable_field');
  }
  if (Object.hasOwn(value, '$sort')) checkArraySort(element, value.$sort, path);

  return {
    ...value,
    $each: Array.from(value.$each, (item) => encodeValue(element, item, path, now)),
  };
}

function checkArraySort(element: AnyField, sort: unknown, path: string): void {
  if (!element.definition.fields) {
    if (hasCodec(element) || (sort !== 1 && sort !== -1)) {
      fail(path, '$sort requires non-codec scalar values and direction 1 or -1');
    }
    return;
  }

  record(sort, path);
  if (!Object.keys(sort).length) fail(path, '$sort cannot be empty');
  for (const [key, direction] of Object.entries(sort)) {
    if (direction !== 1 && direction !== -1) fail(path, '$sort directions must be 1 or -1');
    if (hasCodec(resolvePath(element.definition.fields, key, true))) {
      fail(path, '$sort cannot compare codec values');
    }
  }
}
