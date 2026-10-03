import { MicaValidationError } from './errors.js';
import { ObjectId, type Collection, type Document } from 'mongodb';
import type { Fields } from './fields.js';
import { decodeDocument } from './codec.js';
import { readProjection } from './projection.js';
import {
  optionsRecord,
  prepareFilter,
  prepareQueryOptions,
  queryOptionKeys,
} from './query-options.js';

/** Each page is a separate query; no server cursor remains open while processing it. */
export function createChunks(
  native: Collection,
  fields: Fields,
  input: unknown,
  options: unknown,
  ready: () => void,
): AsyncGenerator<Document[], void, void> {
  const values = optionsRecord(
    options,
    ['size', 'projection', 'afterId', ...queryOptionKeys],
    'chunks',
  );
  if (typeof values.size !== 'number' || !Number.isSafeInteger(values.size) || values.size <= 0) {
    throw new MicaValidationError(
      'invalid_option',
      'size',
      'chunks size: expected a positive safe integer',
    );
  }
  const stringIds = fields._id?.definition.kind === 'string';
  const validId = (value: unknown): value is string | ObjectId =>
    stringIds ? typeof value === 'string' : value instanceof ObjectId;
  const copyId = (value: string | ObjectId) =>
    typeof value === 'string' ? value : new ObjectId(value.toHexString());
  const compareId = (left: string | ObjectId, right: string | ObjectId) =>
    Buffer.compare(
      Buffer.from(typeof left === 'string' ? left : left.toHexString()),
      Buffer.from(typeof right === 'string' ? right : right.toHexString()),
    );
  if (values.afterId !== undefined && !validId(values.afterId)) {
    throw new MicaValidationError(
      'invalid_option',
      'afterId',
      `chunks afterId: expected ${stringIds ? 'a string' : 'an ObjectId'}`,
    );
  }
  const size = values.size;
  const queryOptions = prepareQueryOptions(values);
  if (stringIds) {
    if (
      queryOptions.collation &&
      (queryOptions.collation.locale !== 'simple' ||
        Object.keys(queryOptions.collation).length !== 1)
    )
      throw new MicaValidationError(
        'invalid_option',
        'collation',
        'String ID chunks require simple collation',
      );
    queryOptions.collation = { locale: 'simple' };
  }
  const baseFilter = prepareFilter(fields, input);
  const projection = readProjection(fields, values.projection);
  const omitId = projection._id === 0;
  // Removing the exclusion includes _id in both inclusion and exclusion modes.
  // Its outward visibility still follows the original effective projection.
  if (omitId) delete projection._id;
  let lastId = values.afterId === undefined ? undefined : copyId(values.afterId);

  return (async function* () {
    while (true) {
      queryOptions.signal?.throwIfAborted();
      ready();
      // Intersect, rather than overwrite, any caller-supplied _id restrictions.
      const pageFilter =
        lastId !== undefined ? { $and: [baseFilter, { _id: { $gt: lastId } }] } : baseFilter;
      const cursor = native.find(pageFilter, {
        ...queryOptions,
        projection,
        sort: { _id: 1 },
        limit: size,
        batchSize: size,
      });
      let documents: Document[];
      try {
        documents = await cursor.toArray();
      } catch (error) {
        await cursor.close().catch(() => {});
        throw error;
      }
      await cursor.close();
      if (!documents.length) return;

      // Capture progress before yielding mutable application documents. IDs in
      // malformed legacy rows must not cause skipped pages or an endless loop.
      for (const document of documents) {
        if (
          !validId(document._id) ||
          (lastId !== undefined && compareId(document._id, lastId) <= 0)
        ) {
          throw new Error(
            `chunks requires strictly increasing ${stringIds ? 'string' : 'ObjectId'} _id values`,
          );
        }
        lastId = copyId(document._id);
      }
      const batch = documents.map((document) => {
        if (omitId) delete document._id;
        return decodeDocument(fields, document);
      });
      yield batch;
      if (documents.length < size) return;
    }
  })();
}
