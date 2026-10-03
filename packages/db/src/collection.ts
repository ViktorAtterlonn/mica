import { MicaValidationError } from './errors.js';
import type {
  AnyBulkWriteOperation,
  BulkWriteResult,
  Collection,
  DeleteResult,
  Document,
  FindOptions as NativeFindOptions,
  InsertManyResult,
  InsertOneResult,
  UpdateResult,
} from 'mongodb';
import type { Fields, InferFields } from './fields.js';
import type { CollectionSchema } from './schema.js';
import type {
  BatchOptions,
  BulkOperation,
  CountOptions,
  DistinctPath,
  DistinctValue,
  ChunkOptions,
  Filter,
  FindOneAndUpdateOptions,
  FindOptions,
  Projection,
  QueryOptions,
  SessionOptions,
  IdValue,
  OperationOptions,
  ReadOptions,
  SelectResult,
  Update,
  UpdateOptions,
  UpsertOptions,
  UpsertUpdate,
  WriteMetadata,
} from './query-types.js';
import { decodeDocument, encodeDocument } from './codec.js';
import { encodeUpdate, prepareArrayFilters } from './update.js';
import { hasCodec, resolvePath } from './schema-paths.js';
import { readProjection } from './projection.js';
import { encodeUpsert } from './upsert.js';
import { DecodingCursor, type TypedCursor } from './cursor.js';
import { createChunks } from './chunks.js';
import { createAggregation } from './aggregation.js';
import type { AggregateOptions, Aggregation } from './aggregation-types.js';
import {
  nonemptyArray,
  optionsRecord,
  orderedOption,
  pageNumber,
  prepareFilter,
  prepareSort,
  timestampsOption,
  queryOptionKeys,
  executionOptionKeys,
  operationOptionKeys,
  bulkOperationOptionKeys,
  prepareQueryOptions,
} from './query-options.js';

export interface TypedCollection<F extends Fields> {
  aggregate(options?: AggregateOptions): Aggregation<F>;
  find<const P extends Projection<F> | undefined = undefined>(
    filter?: Filter<F>,
    options?: FindOptions<F, P>,
  ): Promise<SelectResult<F, P>[]>;
  cursor<const P extends Projection<F> | undefined = undefined>(
    filter?: Filter<F>,
    options?: FindOptions<F, P>,
  ): TypedCursor<SelectResult<F, P>, F>;
  chunks<const P extends Projection<F> | undefined = undefined>(
    filter: Filter<F>,
    options: ChunkOptions<F, P>,
  ): AsyncGenerator<SelectResult<F, P>[], void, void>;
  findOne<const P extends Projection<F> | undefined = undefined>(
    filter?: Filter<F>,
    options?: ReadOptions<F, P>,
  ): Promise<SelectResult<F, P> | null>;
  distinct<P extends DistinctPath<F>>(
    path: P,
    filter?: Filter<F>,
    options?: QueryOptions,
  ): Promise<DistinctValue<F, P>[]>;
  exists(filter?: Filter<F>, options?: QueryOptions): Promise<boolean>;
  countDocuments(filter?: Filter<F>, options?: CountOptions): Promise<number>;
  insertOne(
    document: InferFields<F, 'insert'>,
    options?: SessionOptions,
  ): Promise<InsertOneResult<{ _id: IdValue<F> }>>;
  insertMany(
    documents: readonly InferFields<F, 'insert'>[],
    options?: BatchOptions,
  ): Promise<InsertManyResult<{ _id: IdValue<F> }>>;
  updateOne(
    filter: Filter<F>,
    update: UpsertUpdate<F>,
    options: UpsertOptions,
  ): Promise<UpdateResult<{ _id: IdValue<F> }>>;
  updateMany(
    filter: Filter<F>,
    update: UpsertUpdate<F>,
    options: UpsertOptions,
  ): Promise<UpdateResult<{ _id: IdValue<F> }>>;
  updateOne(
    filter: Filter<F>,
    update: Update<F>,
    options?: UpdateOptions,
  ): Promise<UpdateResult<{ _id: IdValue<F> }>>;
  updateMany(
    filter: Filter<F>,
    update: Update<F>,
    options?: UpdateOptions,
  ): Promise<UpdateResult<{ _id: IdValue<F> }>>;
  deleteOne(filter: Filter<F>, options?: OperationOptions): Promise<DeleteResult>;
  deleteMany(filter: Filter<F>, options?: OperationOptions): Promise<DeleteResult>;
  findOneAndUpdate<const P extends Projection<F> | undefined = undefined>(
    filter: Filter<F>,
    update: UpsertUpdate<F>,
    options: Omit<FindOneAndUpdateOptions<F, P>, 'upsert' | 'arrayFilters'> &
      UpsertOptions & { includeResultMetadata?: false },
  ): Promise<SelectResult<F, P> | null>;
  findOneAndUpdate<const P extends Projection<F> | undefined = undefined>(
    filter: Filter<F>,
    update: UpsertUpdate<F>,
    options: Omit<FindOneAndUpdateOptions<F, P>, 'upsert' | 'arrayFilters'> &
      UpsertOptions & { includeResultMetadata: true },
  ): Promise<WriteMetadata<SelectResult<F, P>>>;
  findOneAndUpdate<const P extends Projection<F> | undefined = undefined>(
    filter: Filter<F>,
    update: Update<F>,
    options: FindOneAndUpdateOptions<F, P> & { includeResultMetadata: true },
  ): Promise<WriteMetadata<SelectResult<F, P>>>;
  findOneAndUpdate<const P extends Projection<F> | undefined = undefined>(
    filter: Filter<F>,
    update: Update<F>,
    options?: FindOneAndUpdateOptions<F, P>,
  ): Promise<SelectResult<F, P> | null>;
  findOneAndDelete<const P extends Projection<F> | undefined = undefined>(
    filter: Filter<F>,
    options?: Omit<ReadOptions<F, P>, 'readPreference'>,
  ): Promise<SelectResult<F, P> | null>;
  bulkWrite(
    operations: readonly BulkOperation<F>[],
    options?: BatchOptions,
  ): Promise<BulkWriteResult>;
}

type PreparedReadOptions = Pick<
  NativeFindOptions,
  | 'projection'
  | 'sort'
  | 'skip'
  | 'limit'
  | 'batchSize'
  | 'collation'
  | 'hint'
  | 'readPreference'
  | 'session'
  | 'timeoutMS'
  | 'maxTimeMS'
> & { signal?: AbortSignal };

export function bindCollection<F extends Fields>(
  native: Collection,
  schema: CollectionSchema<F>,
  ready: () => void,
): TypedCollection<F> {
  const fields = schema.$fields;
  const filter = (input: unknown) => prepareFilter(fields, input);
  const decode = (value: Document | null) =>
    value === null ? null : decodeDocument(fields, value);

  function readOptions(input: unknown, extra: readonly string[] = []): PreparedReadOptions {
    const options = optionsRecord(
      input,
      ['projection', 'sort', ...queryOptionKeys, ...extra],
      'read options',
    );
    const result: PreparedReadOptions = {
      ...prepareQueryOptions(options),
      projection: readProjection(fields, options.projection),
    };
    if (options.sort !== undefined) result.sort = prepareSort(fields, options.sort);
    for (const key of ['skip', 'limit', 'batchSize'] as const) {
      if (options[key] !== undefined) result[key] = pageNumber(options[key], key);
    }
    return result;
  }

  function encodeChange(input: unknown, change: unknown, values: Document, now: Date) {
    if (values.upsert !== undefined && typeof values.upsert !== 'boolean')
      throw new MicaValidationError('invalid_option', 'options', 'upsert must be a boolean');
    const prepared = filter(input);
    if (values.upsert === true && values.arrayFilters !== undefined)
      throw new MicaValidationError(
        'invalid_option',
        'options',
        'Array filters are unsupported on upserts',
      );
    const arrayFilters =
      values.upsert === true ? undefined : prepareArrayFilters(fields, change, values.arrayFilters);
    return {
      ...(arrayFilters !== undefined ? { arrayFilters } : {}),
      filter: prepared,
      update:
        values.upsert === true
          ? // Validation uses application values; the BSON snapshot wraps numeric values.
            encodeUpsert(fields, input as Document, change, now, timestampsOption(values))
          : encodeUpdate(fields, change, now, timestampsOption(values)),
      upsert: values.upsert === true,
    };
  }

  async function update(
    method: 'updateOne' | 'updateMany',
    input: unknown,
    change: unknown,
    options: unknown,
  ) {
    ready();
    const values = optionsRecord(
      options,
      ['upsert', 'timestamps', 'arrayFilters', ...operationOptionKeys],
      method,
    );
    const prepared = encodeChange(input, change, values, new Date());
    return native[method](prepared.filter, prepared.update, {
      ...prepareQueryOptions(values),
      upsert: prepared.upsert,
      ...(prepared.arrayFilters !== undefined ? { arrayFilters: prepared.arrayFilters } : {}),
    });
  }

  function encodeBulk(input: unknown, now: Date): AnyBulkWriteOperation<Document> {
    const entry = optionsRecord(
      input,
      ['insertOne', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany'],
      'bulk operation',
    );
    const names = Object.keys(entry);
    if (names.length !== 1)
      throw new MicaValidationError(
        'invalid_option',
        'options',
        'Bulk entries require exactly one operation',
      );
    const name = names[0]!;
    // An explicitly undefined payload is not an omitted options object.
    if (entry[name] === undefined)
      throw new MicaValidationError(
        'invalid_option',
        'options',
        `${name}: operation payload is required`,
      );
    if (name === 'insertOne') {
      const operation = optionsRecord(entry[name], ['document'], name);
      return { insertOne: { document: encodeDocument(fields, operation.document, now) } };
    }
    if (name === 'updateOne' || name === 'updateMany') {
      const operation = optionsRecord(
        entry[name],
        ['filter', 'update', 'upsert', 'timestamps', 'arrayFilters', ...bulkOperationOptionKeys],
        name,
      );
      const prepared = {
        ...prepareQueryOptions(operation),
        ...encodeChange(operation.filter, operation.update, operation, now),
      };
      return name === 'updateOne' ? { updateOne: prepared } : { updateMany: prepared };
    }
    const operation = optionsRecord(entry[name], ['filter', ...bulkOperationOptionKeys], name);
    const prepared = { ...prepareQueryOptions(operation), filter: filter(operation.filter) };
    return name === 'deleteOne' ? { deleteOne: prepared } : { deleteMany: prepared };
  }

  function cursor(input: unknown = {}, options?: unknown) {
    ready();
    const preparedFilter = filter(input);
    const preparedOptions = readOptions(options, ['skip', 'limit', 'batchSize']);
    return new DecodingCursor(
      native.find(preparedFilter, preparedOptions),
      fields,
      ready,
      preparedOptions.signal,
    );
  }

  const implementation = {
    aggregate(options?: AggregateOptions) {
      return createAggregation(native, fields, ready, options);
    },

    async find(input: unknown = {}, options?: unknown) {
      return cursor(input, options).toArray();
    },

    cursor,

    chunks(input: unknown, options: unknown) {
      ready();
      return createChunks(native, fields, input, options, ready);
    },

    async findOne(input: unknown = {}, options?: unknown) {
      ready();
      return decode(await native.findOne(filter(input), readOptions(options)));
    },

    async distinct(path: unknown, input: unknown = {}, options?: unknown) {
      ready();
      if (typeof path !== 'string')
        throw new MicaValidationError(
          'invalid_option',
          'options',
          'distinct requires a schema field path',
        );
      if (hasCodec(resolvePath(fields, path, true))) {
        throw new MicaValidationError(
          'invalid_option',
          'options',
          `${path}: distinct on codec-backed fields/containers is unsupported`,
        );
      }
      // Codec-free values already have the same application and stored representations.
      return native.distinct(
        path,
        filter(input),
        prepareQueryOptions(optionsRecord(options, queryOptionKeys, 'distinct')),
      );
    },

    async exists(input: unknown = {}, options?: unknown) {
      ready();
      return (
        (await native.findOne(filter(input), {
          ...prepareQueryOptions(optionsRecord(options, queryOptionKeys, 'exists')),
          projection: { _id: 1 },
        })) !== null
      );
    },

    async countDocuments(input: unknown = {}, options?: unknown) {
      ready();
      const values = optionsRecord(
        options,
        ['skip', 'limit', ...queryOptionKeys],
        'countDocuments',
      );
      const pagination: CountOptions = {};
      if (values.skip !== undefined) pagination.skip = pageNumber(values.skip, 'skip');
      if (values.limit !== undefined) {
        const limit = pageNumber(values.limit, 'limit');
        // Native countDocuments emits $limit: 0, which MongoDB rejects.
        if (limit > 0) pagination.limit = limit;
      }
      return native.countDocuments(filter(input), {
        ...prepareQueryOptions(values),
        ...pagination,
      });
    },

    async insertOne(document: unknown, options?: unknown) {
      ready();
      return native.insertOne(
        encodeDocument(fields, document, new Date()),
        prepareQueryOptions(optionsRecord(options, executionOptionKeys, 'insertOne')),
      );
    },

    async insertMany(documents: unknown, options?: unknown) {
      ready();
      const values = optionsRecord(options, ['ordered', ...executionOptionKeys], 'insertMany');
      const ordered = orderedOption(values);
      nonemptyArray(documents, 'insertMany');
      const now = new Date();
      const encoded = Array.from(documents, (document) => encodeDocument(fields, document, now));
      return native.insertMany(encoded, { ...prepareQueryOptions(values), ordered });
    },

    updateOne(input: unknown, change: unknown, options?: unknown) {
      return update('updateOne', input, change, options);
    },

    updateMany(input: unknown, change: unknown, options?: unknown) {
      return update('updateMany', input, change, options);
    },

    async deleteOne(input: unknown, options?: unknown) {
      ready();
      return native.deleteOne(
        filter(input),
        prepareQueryOptions(optionsRecord(options, operationOptionKeys, 'deleteOne')),
      );
    },

    async deleteMany(input: unknown, options?: unknown) {
      ready();
      return native.deleteMany(
        filter(input),
        prepareQueryOptions(optionsRecord(options, operationOptionKeys, 'deleteMany')),
      );
    },

    async findOneAndUpdate(input: unknown, change: unknown, options?: unknown) {
      ready();
      const values = optionsRecord(
        options,
        [
          'projection',
          'sort',
          'upsert',
          'returnDocument',
          'timestamps',
          'includeResultMetadata',
          'arrayFilters',
          ...operationOptionKeys,
        ],
        'findOneAndUpdate',
      );
      if (
        values.includeResultMetadata !== undefined &&
        typeof values.includeResultMetadata !== 'boolean'
      )
        throw new MicaValidationError(
          'invalid_option',
          'options',
          'includeResultMetadata must be a boolean',
        );
      if (
        values.returnDocument !== undefined &&
        values.returnDocument !== 'before' &&
        values.returnDocument !== 'after'
      ) {
        throw new MicaValidationError(
          'invalid_option',
          'options',
          'returnDocument must be before or after',
        );
      }
      const reads = readOptions(values, [
        'upsert',
        'returnDocument',
        'timestamps',
        'includeResultMetadata',
        'arrayFilters',
      ]);
      const prepared = encodeChange(input, change, values, new Date());
      const result = await native.findOneAndUpdate(prepared.filter, prepared.update, {
        ...(reads as Omit<typeof reads, 'hint'> & { hint?: Document }),
        upsert: prepared.upsert,
        ...(prepared.arrayFilters !== undefined ? { arrayFilters: prepared.arrayFilters } : {}),
        returnDocument: values.returnDocument ?? 'before',
        includeResultMetadata: true,
      });
      const value = decode(result.value);
      return values.includeResultMetadata ? { ...result, value } : value;
    },

    async findOneAndDelete(input: unknown, options?: unknown) {
      ready();
      const values = optionsRecord(
        options,
        ['projection', 'sort', ...operationOptionKeys],
        'findOneAndDelete',
      );
      return decode(
        await native.findOneAndDelete(filter(input), {
          ...(readOptions(values) as Omit<ReturnType<typeof readOptions>, 'hint'> & {
            hint?: Document;
          }),
          includeResultMetadata: false,
        }),
      );
    },

    async bulkWrite(operations: unknown, options?: unknown) {
      ready();
      const values = optionsRecord(options, ['ordered', ...executionOptionKeys], 'bulkWrite');
      const ordered = orderedOption(values);
      nonemptyArray(operations, 'bulkWrite');
      const now = new Date();
      const encoded = Array.from(operations, (operation) => encodeBulk(operation, now));
      return native.bulkWrite(encoded, { ...prepareQueryOptions(values), ordered });
    },
  };

  // Recursive public inference is erased only at this driver boundary. Every
  // operation above applies the shared runtime validation and codec traversal.
  return implementation as unknown as TypedCollection<F>;
}
