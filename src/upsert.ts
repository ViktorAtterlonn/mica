import { MicaValidationError } from './errors.js';
import type { Document } from 'mongodb';
import type { AnyField, Fields } from './fields.js';
import { encodeDocument } from './codec.js';
import { encodeUpdate } from './update.js';
import { record } from './validation.js';
import { resolvePath } from './schema-paths.js';

function assignPath(target: Document, path: string, value: unknown) {
  const parts = path.split('.');
  const key = parts.shift()!;
  if (!parts.length) {
    target[key] = value;
    return;
  }
  const previous = target[key];
  if (previous !== undefined) record(previous, path);
  const nested = { ...previous };
  target[key] = nested;
  assignPath(nested, parts.join('.'), value);
}

const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);

/** Upserts are complete insert validation plus a limited, atomic native update. */
export function encodeUpsert(
  fields: Fields,
  filter: Document,
  input: unknown,
  now: Date,
  timestamps: boolean,
): Document {
  record(input, 'upsert');
  if (
    !Object.keys(input).length ||
    Object.keys(input).some((key) => !['$set', '$setOnInsert', '$inc'].includes(key))
  )
    throw new MicaValidationError(
      'invalid_update',
      'upsert',
      'Upserts support $set, $setOnInsert and $inc',
    );
  const set = Object.hasOwn(input, '$set') ? input.$set : {};
  const onInsert = Object.hasOwn(input, '$setOnInsert') ? input.$setOnInsert : {};
  const inc = Object.hasOwn(input, '$inc') ? input.$inc : {};
  record(inc, '$inc');
  const incPaths = Object.keys(inc);
  if (incPaths.length) encodeUpdate(fields, { $inc: inc }, now, false);
  record(set, '$set');
  record(onInsert, '$setOnInsert');
  const setPaths = Object.keys(set);
  const insertPaths = Object.keys(onInsert);
  const updatePaths = [...setPaths, ...incPaths];
  for (const path of insertPaths) {
    // Insert-only values use the schema's full insertion shape, including immutable fields.
    if (!Object.hasOwn(fields, path))
      throw new MicaValidationError(
        'invalid_update',
        'upsert',
        '$setOnInsert requires top-level schema fields',
      );
    if (updatePaths.some((other) => overlaps(path, other)))
      throw new MicaValidationError(
        'invalid_update',
        'upsert',
        'Conflicting update and $setOnInsert paths',
      );
  }
  const seed: Document = {};
  const equalityPaths: string[] = [];
  for (const [path, condition] of Object.entries(filter)) {
    resolvePath(fields, path, false);
    if (equalityPaths.some((other) => overlaps(path, other)))
      throw new MicaValidationError(
        'invalid_update',
        'upsert',
        'Upsert equality paths cannot overlap',
      );
    equalityPaths.push(path);
    let value = condition;
    if (
      value &&
      typeof value === 'object' &&
      Object.keys(value).some((key) => key.startsWith('$'))
    ) {
      if (Object.keys(value).length !== 1 || !Object.hasOwn(value, '$eq'))
        throw new MicaValidationError(
          'invalid_update',
          'upsert',
          'Upserts require equality-only filters',
        );
      value = value.$eq;
    }
    assignPath(seed, path, value);
  }
  Object.assign(seed, onInsert);
  for (const [path, value] of Object.entries(set)) {
    resolvePath(fields, path, false);
    assignPath(seed, path, value);
  }
  for (const path of incPaths) {
    resolvePath(fields, path, false);
    if (setPaths.some((other) => overlaps(path, other)))
      throw new MicaValidationError('conflicting_paths', path, 'Conflicting $set and $inc paths');
    let base: unknown = seed;
    let missing = false;
    for (const key of path.split('.')) {
      record(base, path);
      if (!Object.hasOwn(base, key)) {
        missing = true;
        break;
      }
      base = base[key];
    }
    if (!missing && (typeof base !== 'number' || !Number.isFinite(base)))
      throw new MicaValidationError(
        'invalid_type',
        path,
        '$inc insertion base must be a finite number',
      );
    // Native upserts increment the equality seed, or zero when the field is missing.
    // Set the final candidate explicitly so its schema default cannot change that rule.
    assignPath(seed, path, (missing ? 0 : (base as number)) + (inc[path] as number));
  }
  const inserted = encodeDocument(fields, seed, now);
  const encodedSet: Document = {};
  for (const path of setPaths) {
    let value: unknown = inserted;
    for (const key of path.split('.')) value = (value as Document)[key];
    encodedSet[path] = value;
  }
  const update =
    setPaths.length || incPaths.length
      ? encodeUpdate(fields, { $set: set, $inc: inc }, now, timestamps, encodedSet)
      : {};
  if (timestamps) {
    for (const [path, field] of Object.entries(fields)) {
      if (field.definition.generated === 'updatedAt') (update.$set ??= {})[path] = new Date(now);
    }
  }
  const written = [...Object.keys(update.$set ?? {}), ...incPaths];
  const defaults: Document = {};
  function flatten(field: AnyField, path: string, value: unknown) {
    if (written.some((other) => other === path || path.startsWith(`${other}.`))) return;
    const beneath = written.some((other) => other.startsWith(`${path}.`));
    if (!beneath || value === null) {
      defaults[path] = value;
      return;
    }
    if (field.definition.fields) {
      for (const [key, child] of Object.entries(field.definition.fields)) {
        if (!Object.hasOwn(value as object, key)) continue;
        flatten(child, `${path}.${key}`, (value as Document)[key]);
      }
      return;
    }
    if (field.definition.kind === 'map') {
      for (const [key, entry] of Object.entries(value as Document)) {
        flatten(field.definition.element!, `${path}.${key}`, entry);
      }
      return;
    }
    defaults[path] = value;
  }
  for (const [path, value] of Object.entries(inserted)) flatten(fields[path]!, path, value);
  if (Object.keys(defaults).length) update.$setOnInsert = defaults;
  if (!Object.keys(update).length)
    throw new MicaValidationError('invalid_update', 'upsert', 'Upsert produced no update');
  return update;
}
