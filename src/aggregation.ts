import { BSON, type Collection, type Document } from 'mongodb';
import { Field, number, type AnyField, type Fields } from './fields.js';
import { decodeDocument } from './codec.js';
import { hasCodec } from './schema-paths.js';
import { readProjection } from './projection.js';
import { record } from './validation.js';
import { MicaValidationError } from './errors.js';
import {
  optionsRecord,
  pageNumber,
  prepareQueryOptions,
  prepareSort,
  queryOptionKeys,
} from './query-options.js';
import type { AggregateOptions, Aggregation } from './aggregation-types.js';
import { prepareAggregateFilter } from './aggregate-filter.js';

function outputName(name: string) {
  if (
    !name ||
    name.startsWith('$') ||
    name.includes('.') ||
    name.includes('\0') ||
    ['__proto__', 'constructor', 'prototype'].includes(name)
  ) {
    throw new MicaValidationError('invalid_option', name, 'Invalid aggregation output field name');
  }
}

function snapshot(document: Document): Document {
  return BSON.deserialize(BSON.serialize(document), { promoteValues: false });
}

function projectedFields(fields: Fields, projection: Document): Fields {
  const inclusion =
    Object.entries(projection).some(([path, mode]) => path !== '_id' && mode === 1) ||
    (projection._id === 1 && !Object.values(projection).includes(0));
  const paths = Object.keys(projection).filter((path) => projection[path] === (inclusion ? 1 : 0));
  if (inclusion && fields._id && projection._id !== 0 && !paths.includes('_id')) paths.push('_id');

  function field(value: AnyField, path: string): AnyField | undefined {
    const whole = paths.includes(path);
    const below = paths.some((selected) => selected.startsWith(`${path}.`));
    if ((!inclusion && whole) || (inclusion && !whole && !below)) return undefined;
    const definition = value.definition;
    if (inclusion && whole) return visible(value);
    if (definition.fields) {
      const children = Object.fromEntries(
        Object.entries(definition.fields).flatMap(([key, child]) => {
          const projected = field(child, `${path}.${key}`);
          return projected ? [[key, projected]] : [];
        }),
      );
      return new Field({ ...definition, selected: true, fields: children });
    }
    if (definition.element && definition.kind === 'array') {
      return new Field({
        ...definition,
        selected: true,
        element: field(definition.element, path)!,
      });
    }
    return new Field({ ...definition, selected: true });
  }

  return Object.fromEntries(
    Object.entries(fields).flatMap(([key, value]) => {
      const projected = field(value, key);
      return projected ? [[key, projected]] : [];
    }),
  );
}

// Explicit inclusion of a whole container also opts into hidden descendants.
function visible(field: AnyField): AnyField {
  const definition = field.definition;
  return new Field({
    ...definition,
    selected: true,
    ...(definition.fields
      ? {
          fields: Object.fromEntries(
            Object.entries(definition.fields).map(([key, child]) => [key, visible(child)]),
          ),
        }
      : {}),
    ...(definition.element ? { element: visible(definition.element) } : {}),
  });
}

function reference(fields: Fields, input: unknown, numeric: boolean): AnyField {
  if (typeof input !== 'string' || !input.startsWith('$') || input.startsWith('$$')) {
    throw new MicaValidationError(
      'invalid_value',
      'group',
      'Expected an aggregation field reference',
    );
  }
  const path = input.slice(1);
  const parts = path.split('.');
  if (parts.length > 5)
    throw new MicaValidationError('unknown_field', path, 'Aggregation path exceeds five levels');
  let current = fields;
  let result: AnyField | undefined;
  let nullable = false;
  for (const [index, part] of parts.entries()) {
    result = Object.hasOwn(current, part) ? current[part] : undefined;
    if (!result)
      throw new MicaValidationError('unknown_field', path, `Unknown aggregation field: ${path}`);
    const definition = result.definition;
    nullable ||= !!definition.optional || !!definition.nullable;
    if (index < parts.length - 1) {
      if (definition.kind !== 'object' || !definition.fields) {
        throw new MicaValidationError(
          'unsupported_operation',
          path,
          'Group references cannot traverse arrays, maps, or atomic values',
        );
      }
      current = definition.fields;
    }
  }
  if (
    !result ||
    hasCodec(result) ||
    !(
      numeric ? ['number'] : ['string', 'number', 'boolean', 'date', 'objectId', 'binary']
    ).includes(result.definition.kind)
  ) {
    throw new MicaValidationError(
      'unsupported_operation',
      path,
      'Group requires a codec-free scalar field of the supported kind',
    );
  }
  return new Field({ ...result.definition, selected: true, optional: false, nullable });
}

function groupFields(fields: Fields, input: unknown): Fields {
  record(input, 'group');
  if (!Object.hasOwn(input, '_id'))
    throw new MicaValidationError('missing_field', '_id', 'group requires _id');
  const result: Fields = {};
  for (const [name, value] of Object.entries(input)) {
    outputName(name);
    if (name === '_id') {
      result._id =
        value === null
          ? new Field({ kind: 'custom', nullable: true })
          : reference(fields, value, false);
      continue;
    }
    record(value, name);
    const entries = Object.entries(value);
    if (entries.length !== 1)
      throw new MicaValidationError(
        'invalid_value',
        name,
        'Expected exactly one group accumulator',
      );
    const [operator, operand] = entries[0]!;
    if (!['$sum', '$avg', '$min', '$max'].includes(operator)) {
      throw new MicaValidationError(
        'unsupported_operation',
        name,
        `Unsupported accumulator: ${operator}`,
      );
    }
    if (operator === '$sum' && typeof operand === 'number') {
      if (!Number.isFinite(operand))
        throw new MicaValidationError('invalid_value', name, '$sum requires a finite number');
    } else {
      reference(fields, operand, true);
    }
    result[name] = operator === '$sum' ? number() : number().nullable();
  }
  return result;
}

class Pipeline {
  constructor(
    private readonly native: Collection,
    private readonly fields: Fields,
    private readonly ready: () => void,
    private readonly options: AggregateOptions,
    private readonly stages: readonly Document[] = [],
  ) {}

  private append(stage: Document, fields = this.fields): Pipeline {
    // Stage constructors own their inputs; preserve Maps used for ordered BSON sort keys.
    return new Pipeline(this.native, fields, this.ready, this.options, [...this.stages, stage]);
  }

  match(filter: unknown): Pipeline {
    return this.append({ $match: prepareAggregateFilter(this.fields, filter) });
  }

  project(projection: unknown): Pipeline {
    const prepared = readProjection(this.fields, projection);
    // Map-entry projections need a separate schema for the surviving dynamic keys.
    // Whole maps remain supported; do not pretend removed entries are still available.
    for (const path of Object.keys(prepared)) {
      let fields = this.fields;
      const parts = path.split('.');
      for (const part of parts.slice(0, -1)) {
        let field = fields[part]!;
        while (field.definition.kind === 'array') field = field.definition.element!;
        if (field.definition.kind === 'map') {
          throw new MicaValidationError(
            'unsupported_operation',
            path,
            'Aggregation projects whole maps, not individual entries',
          );
        }
        fields = field.definition.fields!;
      }
    }
    const fields = projectedFields(this.fields, prepared);
    // MongoDB rejects an empty $project. An empty user projection still applies defaults.
    return Object.keys(prepared).length
      ? this.append({ $project: prepared }, fields)
      : new Pipeline(this.native, fields, this.ready, this.options, this.stages);
  }

  group(specification: unknown): Pipeline {
    const fields = groupFields(this.fields, specification);
    return this.append(snapshot({ $group: specification }), fields);
  }

  sort(sort: unknown): Pipeline {
    return this.append({ $sort: prepareSort(this.fields, sort) });
  }

  skip(count: unknown): Pipeline {
    return this.append({ $skip: pageNumber(count, 'skip') });
  }

  limit(count: unknown): Pipeline {
    const value = pageNumber(count, 'limit');
    if (!value)
      throw new MicaValidationError(
        'invalid_option',
        'limit',
        'Aggregation limit must be positive',
      );
    return this.append({ $limit: value });
  }

  count(name: unknown): Pipeline {
    if (typeof name !== 'string')
      throw new MicaValidationError(
        'invalid_option',
        'count',
        'count requires an output field name',
      );
    outputName(name);
    if (name === '_id')
      throw new MicaValidationError(
        'invalid_option',
        'count',
        'count cannot use _id as its output field',
      );
    return this.append({ $count: name }, { [name]: number() });
  }

  async toArray(): Promise<Document[]> {
    this.ready();
    this.options.signal?.throwIfAborted();
    const projection = readProjection(this.fields, undefined);
    const stages = [...this.stages];
    if (Object.keys(projection).length) stages.push({ $project: projection });
    const cursor = this.native.aggregate(stages, this.options);
    try {
      const values = await cursor.toArray();
      return values.map((value) => decodeDocument(this.fields, value));
    } finally {
      // Cleanup must not mask a driver or application codec error.
      await cursor.close().catch(() => {});
    }
  }
}

export function createAggregation<F extends Fields>(
  native: Collection,
  fields: F,
  ready: () => void,
  input?: AggregateOptions,
): Aggregation<F> {
  ready();
  const values = optionsRecord(
    input,
    [...queryOptionKeys, 'allowDiskUse', 'batchSize'],
    'aggregate',
  );
  const options: AggregateOptions = prepareQueryOptions(values);
  if (values.allowDiskUse !== undefined) {
    if (typeof values.allowDiskUse !== 'boolean')
      throw new MicaValidationError(
        'invalid_option',
        'allowDiskUse',
        'allowDiskUse must be a boolean',
      );
    options.allowDiskUse = values.allowDiskUse;
  }
  if (values.batchSize !== undefined) options.batchSize = pageNumber(values.batchSize, 'batchSize');
  return new Pipeline(native, fields, ready, options) as unknown as Aggregation<F>;
}
