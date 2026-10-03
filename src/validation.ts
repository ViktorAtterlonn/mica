import { MicaValidationError, type MicaValidationCode } from './errors.js';

export function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new MicaValidationError('invalid_type', label, `${label}: expected a plain object`);
  }
}

export function fail(
  path: string,
  message: string,
  code: MicaValidationCode = 'invalid_value',
): never {
  throw new MicaValidationError(code, path, `${path}: ${message}`);
}

const bsonTypes = [
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
] as const;

export type BsonType = (typeof bsonTypes)[number];
export const bsonTypeNames: ReadonlySet<string> = new Set(bsonTypes);
