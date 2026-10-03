import { MicaValidationError } from './errors.js';
import {
  BSON,
  ClientSession,
  ReadPreference,
  type Document,
  type ReadPreferenceMode,
} from 'mongodb';
import type { QueryOptions } from './query-types.js';
import type { Fields } from './fields.js';
import { checkFilter } from './filter.js';
import { hasCodec, resolvePath } from './schema-paths.js';
import { record } from './validation.js';

export function optionsRecord(input: unknown, allowed: readonly string[], label: string): Document {
  if (input === undefined) return {};
  record(input, label);
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key))
      throw new MicaValidationError('invalid_option', key, `${label}: unsupported option ${key}`);
  }
  return input;
}

export function prepareFilter(fields: Fields, filter: unknown): Document {
  checkFilter(fields, filter);
  // Cursors execute later; caller mutation must not bypass the checked filter.
  // Preserve BSON numeric types rather than promoting them to JavaScript numbers.
  return BSON.deserialize(BSON.serialize(filter), { promoteValues: false });
}

export function prepareSort(fields: Fields, input: unknown): Map<string, 1 | -1> {
  if (!Array.isArray(input)) record(input, 'sort');
  const entries: unknown[] = Array.isArray(input) ? Array.from(input) : Object.entries(input);
  if (!entries.length)
    throw new MicaValidationError('invalid_option', 'options', 'sort: expected at least one field');
  const sort = new Map<string, 1 | -1>();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2)
      throw new MicaValidationError(
        'invalid_option',
        'options',
        'sort: expected [path, direction] pairs',
      );
    const [path, direction] = entry;
    if (typeof path !== 'string' || (direction !== 1 && direction !== -1)) {
      throw new MicaValidationError(
        'invalid_option',
        'options',
        'sort: expected a field path and direction 1 or -1',
      );
    }
    if (sort.has(path))
      throw new MicaValidationError('invalid_option', 'options', `sort: duplicate path ${path}`);
    if (hasCodec(resolvePath(fields, path, true))) {
      throw new MicaValidationError(
        'invalid_option',
        'options',
        `${path}: sorting codec-backed fields/ancestors is unsupported`,
      );
    }
    sort.set(path, direction);
  }
  return sort;
}

export function pageNumber(value: unknown, name: string): number {
  const minimum = name === 'batchSize' ? 1 : 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new MicaValidationError(
      'invalid_option',
      name,
      `${name}: expected a safe integer >= ${minimum}`,
    );
  }
  return value;
}

export function orderedOption(options: Document): boolean {
  if (options.ordered !== undefined && typeof options.ordered !== 'boolean') {
    throw new MicaValidationError('invalid_option', 'options', 'ordered must be a boolean');
  }
  return options.ordered ?? true;
}

export function nonemptyArray(input: unknown, label: string): asserts input is unknown[] {
  if (!Array.isArray(input) || !input.length)
    throw new MicaValidationError(
      'invalid_option',
      'options',
      `${label}: expected a nonempty array`,
    );
}

export function timestampsOption(options: Document): boolean {
  if (options.timestamps !== undefined && typeof options.timestamps !== 'boolean')
    throw new MicaValidationError('invalid_option', 'options', 'timestamps must be a boolean');
  return options.timestamps ?? true;
}

export const executionOptionKeys = ['session', 'timeoutMS', 'maxTimeMS', 'signal'] as const;
export const queryOptionKeys = [
  'collation',
  'hint',
  'readPreference',
  ...executionOptionKeys,
] as const;
export const operationOptionKeys = ['collation', 'hint', ...executionOptionKeys] as const;
export const bulkOperationOptionKeys = ['collation', 'hint'] as const;

export function prepareQueryOptions(values: Document): QueryOptions {
  const output: QueryOptions = {};
  for (const key of ['timeoutMS', 'maxTimeMS'] as const) {
    if (values[key] !== undefined) {
      if (!Number.isSafeInteger(values[key]) || values[key] < 0)
        throw new MicaValidationError(
          'invalid_option',
          key,
          `${key} requires a nonnegative safe integer`,
        );
      output[key] = values[key];
    }
  }
  if (values.signal !== undefined) {
    if (!(values.signal instanceof AbortSignal))
      throw new MicaValidationError('invalid_option', 'signal', 'signal requires an AbortSignal');
    values.signal.throwIfAborted();
    output.signal = values.signal;
  }
  if (values.session !== undefined) {
    if (!(values.session instanceof ClientSession) || values.session.hasEnded)
      throw new MicaValidationError(
        'invalid_option',
        'options',
        'session must be an active ClientSession',
      );
    output.session = values.session;
  }
  if (values.collation !== undefined) {
    record(values.collation, 'collation');
    if (typeof values.collation.locale !== 'string' || !values.collation.locale)
      throw new MicaValidationError('invalid_option', 'options', 'collation requires a locale');
    output.collation = BSON.deserialize(
      BSON.serialize(values.collation),
    ) as QueryOptions['collation'] & {};
  }
  if (values.hint !== undefined) {
    if (typeof values.hint === 'string') {
      if (!values.hint)
        throw new MicaValidationError('invalid_option', 'options', 'hint cannot be empty');
      output.hint = values.hint;
    } else {
      record(values.hint, 'hint');
      if (!Object.keys(values.hint).length)
        throw new MicaValidationError('invalid_option', 'options', 'hint cannot be empty');
      for (const direction of Object.values(values.hint))
        if (![1, -1, 'hashed'].includes(direction as string | number))
          throw new MicaValidationError(
            'invalid_option',
            'options',
            'hint requires index directions or an index name',
          );
      output.hint = { ...values.hint };
    }
  }
  if (values.readPreference !== undefined) {
    if (
      typeof values.readPreference !== 'string' &&
      !(values.readPreference instanceof ReadPreference)
    )
      throw new MicaValidationError(
        'invalid_option',
        'options',
        'readPreference requires a mode or ReadPreference',
      );
    const preference =
      typeof values.readPreference === 'string'
        ? new ReadPreference(values.readPreference as ReadPreferenceMode)
        : values.readPreference;
    // A cursor must not retain caller-mutable tags/options.
    output.readPreference = new ReadPreference(
      preference.mode,
      preference.tags?.map((tag) => ({ ...tag })),
      {
        ...(preference.maxStalenessSeconds !== undefined
          ? { maxStalenessSeconds: preference.maxStalenessSeconds }
          : {}),
        ...(preference.hedge !== undefined ? { hedge: { ...preference.hedge } } : {}),
      },
    );
  }
  return output;
}
