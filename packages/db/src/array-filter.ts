import { BSON, type Document } from 'mongodb';
import type { AnyField } from './fields.js';
import type { ArrayElementFilter } from './query-types.js';
import { checkFilter } from './filter.js';
import { record } from './validation.js';
import { MicaValidationError } from './errors.js';

/** Build a native array-filter document with a predicate inferred from a selected array field. */
export function arrayFilter<F extends AnyField>(
  identifier: string,
  field: F & (F['$types']['kind'] extends 'array' ? unknown : never),
  predicate: ArrayElementFilter<NoInfer<F>>,
): Document {
  if (typeof identifier !== 'string' || !/^[a-z][a-zA-Z0-9]*$/.test(identifier))
    throw new MicaValidationError(
      'invalid_option',
      'arrayFilters',
      'Invalid array filter identifier',
    );
  const element = field.definition.element;
  if (field.definition.kind !== 'array' || field.definition.codec || !element)
    throw new MicaValidationError(
      'invalid_type',
      identifier,
      'arrayFilter requires a non-codec array',
    );

  function prefix(input: unknown): Document {
    record(input, identifier);
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) =>
        ['$and', '$or', '$nor'].includes(key)
          ? [key, (value as unknown[]).map(prefix)]
          : [`${identifier}.${key}`, value],
      ),
    );
  }

  let filter: Document;
  if (element.definition.fields && !element.definition.codec) {
    checkFilter(element.definition.fields, predicate);
    filter = prefix(predicate);
  } else {
    filter = { [identifier]: predicate };
  }
  checkFilter({ [identifier]: element }, filter);
  // The write boundary validates this document again; control operands such as
  // $size and numeric $type must remain JavaScript numbers.
  return BSON.deserialize(BSON.serialize(filter));
}
