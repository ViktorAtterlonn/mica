export {
  string,
  number,
  boolean,
  date,
  objectId,
  binary,
  enum_,
  object,
  array,
  map,
  timestamps,
  customType,
} from './fields.js';

export type { AnyField, Fields, InferFields, JsonSchema, CustomValueOptions } from './fields.js';
export { collection, jsonSchema, discoverMetadata } from './schema.js';

export type { CollectionSchema } from './schema.js';
export { createDatabase } from './database.js';

export type {
  Database,
  DatabaseStatus,
  DatabaseOptions,
  DatabaseEvents,
  TypedCollection,
} from './database.js';

export type { Filter, Update, Projection, Project, SelectResult } from './query-types.js';

export { index } from './indexes.js';
export type { IndexFields, IndexField, IndexDefinition, PartialIndexFilter } from './indexes.js';

export type { TypedCursor } from './cursor.js';
export type {
  Sort,
  QueryOptions,
  IdValue,
  OperationOptions,
  SessionOptions,
  ExecutionOptions,
  ReadOptions,
  FindOptions,
  CountOptions,
  DistinctPath,
  DistinctValue,
  ChunkOptions,
  BatchOptions,
  UpdateOptions,
  UpsertOptions,
  UpsertUpdate,
  WriteMetadata,
  FindOneAndUpdateOptions,
  BulkOperation,
} from './query-types.js';

export { MicaValidationError } from './errors.js';
export type { MicaValidationCode } from './errors.js';

export { arrayFilter } from './array-filter.js';
export type { ArrayElementFilter } from './query-types.js';
export type {
  AggregateOptions,
  Aggregation,
  AggregateAccumulator,
  AggregateReference,
} from './aggregation-types.js';
export type { AggregateFilter } from './aggregate-filter.js';
