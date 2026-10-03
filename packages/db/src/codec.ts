import { Binary, ObjectId, type Document } from 'mongodb';
import type { AnyField, Fields, Kind } from './fields.js';
import { checkMapKey } from './fields.js';
import { fail, record } from './validation.js';

function matchesKind(kind: Kind, value: unknown): boolean {
  switch (kind) {
    case 'custom':
      return true;
    case 'string':
      return typeof value === 'string';

    case 'number':
      return typeof value === 'number' && Number.isFinite(value);

    case 'boolean':
      return typeof value === 'boolean';

    case 'date':
      return value instanceof Date && !Number.isNaN(value.getTime());

    case 'objectId':
      return value instanceof ObjectId;

    case 'binary':
      return value instanceof Binary;

    case 'array':
      return Array.isArray(value);

    case 'map':
      return (
        !!value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        [Object.prototype, null].includes(Object.getPrototypeOf(value))
      );

    case 'object':
      return (
        !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
      );
  }
}

function validate(field: AnyField, value: unknown, path: string) {
  const definition = field.definition;

  if (value === null) {
    if (!definition.nullable) {
      fail(path, 'null is not allowed');
    }

    return;
  }

  const valid = definition.validate
    ? definition.validate(value)
    : matchesKind(definition.kind, value);

  if (!valid) {
    fail(path, `expected ${definition.kind}`, 'invalid_type');
  }

  // MongoDB counts Unicode code points for minLength/maxLength.
  let size: number | undefined;

  if (typeof value === 'string') {
    size = [...value].length;
  } else if (Array.isArray(value)) {
    size = value.length;
  } else if (typeof value === 'number') {
    size = value;
  }

  if (size !== undefined && definition.min !== undefined && size < definition.min) {
    fail(path, `below minimum ${definition.min}`);
  }

  if (size !== undefined && definition.max !== undefined && size > definition.max) {
    fail(path, `above maximum ${definition.max}`);
  }

  if (definition.integer && !Number.isInteger(value)) {
    fail(path, 'expected integer');
  }

  if (definition.values && !definition.values.includes(value as string)) {
    fail(path, 'invalid enum value');
  }

  if (definition.pattern && !definition.pattern.test(value as string)) {
    fail(path, 'pattern mismatch');
  }
}

export function encodeValue(field: AnyField, value: unknown, path: string, now: Date): unknown {
  if (value === undefined)
    fail(path, 'undefined values and missing array elements are unsupported');
  validate(field, value, path);

  if (value === null) {
    return null;
  }

  const definition = field.definition;

  if (definition.codec) {
    const encoded = definition.codec.encode(value);

    if (encoded === undefined || encoded instanceof Promise) {
      fail(path, 'codec must synchronously return a stored value');
    }

    return encoded;
  }

  if (definition.fields) {
    return encodeDocument(definition.fields, value, now, path);
  }

  if (definition.kind === 'map') {
    return Object.fromEntries(
      Object.entries(value as Document).map(([key, item]) => {
        checkMapKey(key, `${path}.${key}`);
        return [key, encodeValue(definition.element!, item, `${path}.${key}`, now)];
      }),
    );
  }

  if (definition.element) {
    return Array.from(value as unknown[], (item, i) =>
      encodeValue(definition.element!, item, `${path}.${i}`, now),
    );
  }

  return value;
}

export function encodeDocument(fields: Fields, input: unknown, now: Date, path = ''): Document {
  record(input, path || 'document');

  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(fields, key)) {
      fail(path ? `${path}.${key}` : key, 'unknown field', 'unknown_field');
    }
  }

  const output: Document = {};

  for (const [key, field] of Object.entries(fields)) {
    const definition = field.definition;
    let value = Object.hasOwn(input, key) ? input[key] : undefined;

    if (value === undefined) {
      if (Object.hasOwn(input, key)) {
        fail(path ? `${path}.${key}` : key, 'omit optional fields instead of passing undefined');
      }

      if (definition.defaultValue) {
        value = definition.defaultValue();
      } else if (definition.generated) {
        value = definition.generated === 'id' ? new ObjectId() : new Date(now);
      } else if (definition.optional) {
        continue;
      } else {
        fail(path ? `${path}.${key}` : key, 'required field is missing', 'missing_field');
      }
    }

    output[key] = encodeValue(field, value, path ? `${path}.${key}` : key, now);
  }

  return output;
}

export function decodeDocument(fields: Fields, input: Document): Document {
  const output: Document = {};

  for (const [key, value] of Object.entries(input)) {
    const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
    // No defaults/required checks on reads: projections may omit any field.
    Object.defineProperty(output, key, {
      value: field ? decodeValue(field, value) : value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return output;
}

function decodeValue(field: AnyField, value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  const definition = field.definition;

  if (definition.codec) {
    const decoded = definition.codec.decode(value);

    if (decoded === undefined || decoded instanceof Promise) {
      throw new Error('Codec must synchronously return an application value');
    }

    return decoded;
  }

  if (definition.fields) {
    return decodeDocument(definition.fields, value as Document);
  }

  if (definition.kind === 'map') {
    return Object.fromEntries(
      Object.entries(value as Document).map(([key, item]) => [
        key,
        decodeValue(definition.element!, item),
      ]),
    );
  }

  if (definition.element) {
    return (value as unknown[]).map((item) => decodeValue(definition.element!, item));
  }

  return value;
}
