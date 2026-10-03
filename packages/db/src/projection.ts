import type { Document } from 'mongodb';
import type { Fields } from './fields.js';
import { MicaValidationError } from './errors.js';
import { resolvePath } from './schema-paths.js';
import { fail, record } from './validation.js';

export function checkProjection(
  fields: Fields,
  projection: unknown,
): asserts projection is Document {
  record(projection, 'projection');
  const modes = new Set<unknown>();

  const paths = Object.keys(projection);
  for (const [key, mode] of Object.entries(projection)) {
    resolvePath(fields, key, true);
    if (mode !== 0 && mode !== 1) fail(key, 'only 0/1 projections are supported');
    if (paths.some((other) => other !== key && other.startsWith(`${key}.`)))
      fail(key, 'conflicting projection paths', 'conflicting_paths');

    if (key !== '_id') {
      modes.add(mode);
    }
  }

  if (modes.size > 1) {
    throw new MicaValidationError(
      'invalid_projection',
      'projection',
      'Cannot mix inclusion and exclusion projections (except _id)',
    );
  }
}

/** Validate and snapshot the caller's projection before executing the query. */
export function readProjection(fields: Fields, input: unknown): Document {
  if (input === undefined) return {};
  checkProjection(fields, input);
  return { ...input };
}
