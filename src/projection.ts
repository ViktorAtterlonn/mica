import type { Document } from 'mongodb';
import type { AnyField, Fields } from './fields.js';
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

/** Resolve schema defaults into a server projection before any codec is run. */
export function readProjection(fields: Fields, input: unknown): Document {
  if (input !== undefined) checkProjection(fields, input);
  const projection: Document = { ...(input as Document | undefined) };
  const inclusion =
    Object.entries(projection).some(([key, mode]) => key !== '_id' && mode === 1) ||
    (projection._id === 1 && !Object.values(projection).includes(0));

  if (inclusion) {
    if (fields._id?.definition.selected === false && projection._id !== 1) projection._id = 0;
    return projection;
  }

  // MongoDB permits _id:1 alongside exclusions. Remove the redundant inclusion
  // so an otherwise empty projection retains schema defaults.
  const explicitId = projection._id === 1;
  if (explicitId) delete projection._id;
  function visit(field: AnyField, path: string) {
    if (
      Object.keys(projection).some(
        (key) => projection[key] === 0 && (path === key || path.startsWith(`${key}.`)),
      )
    )
      return;
    if (field.definition.selected === false) {
      for (const key of Object.keys(projection))
        if (key.startsWith(`${path}.`)) delete projection[key];
      projection[path] = 0;
      return;
    }
    for (const [key, child] of Object.entries(field.definition.fields ?? {})) {
      visit(child, `${path}.${key}`);
    }
    if (field.definition.element) visit(field.definition.element, path);
  }

  for (const [key, field] of Object.entries(fields)) {
    if (projection[key] === 0 || (key === '_id' && explicitId)) continue;
    visit(field, key);
  }
  return projection;
}
