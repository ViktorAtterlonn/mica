import type { AnyField, Fields } from './fields.js';
import { checkMapKey } from './fields.js';
import { fail } from './validation.js';

export function hasCodec(field: AnyField): boolean {
  const definition = field.definition;

  return (
    !!definition.codec ||
    (!!definition.element && hasCodec(definition.element)) ||
    Object.values(definition.fields ?? {}).some(hasCodec)
  );
}

function mapEntry(field: AnyField): AnyField {
  return { ...field, definition: { ...field.definition, optional: true } };
}

export function resolvePath(fields: Fields, path: string, arrays: boolean): AnyField {
  const segments = path.split('.');

  if (segments.length > 5) {
    fail(path, 'Phase 0 paths support at most five segments');
  }

  let depth = 0;
  let currentFields = fields;
  let field: AnyField | undefined;

  for (let i = 0; i < segments.length; i++) {
    if (depth++ >= 5) fail(path, 'Paths support at most five schema traversal levels');
    const segment = segments[i]!;

    if (!Object.hasOwn(currentFields, segment)) {
      fail(path, 'unknown or unsupported path', 'unknown_field');
    }

    field = currentFields[segment]!;

    if (i === segments.length - 1) continue;

    if (field.definition.codec) {
      fail(path, 'cannot address inside a codec');
    }

    while (arrays && field.definition.kind === 'array' && field.definition.element) {
      if (depth++ >= 5) fail(path, 'Paths support at most five schema traversal levels');
      field = field.definition.element;
    }

    if (field.definition.kind === 'map') {
      if (depth++ >= 5) fail(path, 'Paths support at most five schema traversal levels');
      checkMapKey(segments[++i]!, path);
      if (i !== segments.length - 1) fail(path, 'Map entries are atomic paths');
      return mapEntry(field.definition.element!);
    }
    if (!field.definition.fields) {
      fail(path, 'unsupported nested/array write path');
    }

    currentFields = field.definition.fields;
  }

  return field!;
}

function isProtected(field: AnyField): boolean {
  return !!(field.definition.immutable || field.definition.generated);
}

export function containsProtected(field: AnyField): boolean {
  return (
    isProtected(field) ||
    Object.values(field.definition.fields ?? {}).some(containsProtected) ||
    !!(field.definition.element && containsProtected(field.definition.element))
  );
}

export function resolveWritePath(
  fields: Fields,
  path: string,
  bindings?: Map<string, AnyField>,
): AnyField {
  const parts = path.split('.');
  if (!parts.length || parts.length > 5)
    fail(path, 'Write paths support at most five traversal levels');
  let current = fields;
  let field: AnyField | undefined;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (field?.definition.kind === 'map') {
      checkMapKey(part, path);
      if (i !== parts.length - 1) fail(path, 'Map entries are atomic paths');
      field = mapEntry(field.definition.element!);
    } else if (field?.definition.element) {
      const match = /^\$\[([a-z][a-zA-Z0-9]*)\]$/.exec(part);
      if (!/^(0|[1-9][0-9]*)$/.test(part) && part !== '$' && part !== '$[]' && !match)
        fail(path, 'Expected a numeric or positional array selector');
      if (/^[0-9]+$/.test(part) && !Number.isSafeInteger(Number(part)))
        fail(path, 'Array index must be a safe integer');
      field = field.definition.element;
      if (match && bindings) {
        const identifier = match[1]!;
        if (bindings.has(identifier) && bindings.get(identifier) !== field)
          fail(path, 'Array filter identifier refers to different element schemas');
        bindings.set(identifier, field);
      }
    } else {
      if (!Object.hasOwn(current, part))
        fail(path, 'unknown or unsupported write path', 'unknown_field');
      field = current[part]!;
    }
    if (isProtected(field) || (i === 0 && part === '_id'))
      fail(path, 'immutable field cannot be updated', 'immutable_field');
    if (i < parts.length - 1 && field.definition.codec) fail(path, 'cannot address inside a codec');
    current = field.definition.fields ?? {};
  }
  return field!;
}
