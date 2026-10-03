// Executed by tsc only. Every @ts-expect-error must correspond to a real compiler error.
import { Binary, ObjectId } from 'mongodb';
import { Products } from '../examples/entities/products.js';
import { boolean, createDatabase, string, type Filter, type Projection } from '../src/index.js';
type Select = typeof Products.$inferSelect;
type Insert = typeof Products.$inferInsert;
type Stored = typeof Products.$inferStored;
type Update = typeof Products.$inferUpdate;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expect<T extends true>() {}
expect<Equal<Select['internalNotes'], string | undefined>>();
expect<Equal<Stored['internalNotes'], Binary | undefined>>();
expect<Equal<Select['status'], 'draft' | 'published' | 'archived'>>();
expect<Equal<Select['createdAt'], Date>>();
expect<Equal<Select['details']['count'], number>>();
expect<Equal<Select['description'], string | null | undefined>>();
expect<Equal<Stored['variants'][number]['secret'], Binary | undefined>>();
const valid: Insert = {
  organizationId: new ObjectId(),
  title: 'Hello',
  details: { label: 'Nested' },
  variants: [],
  secrets: [],
};
const defaults: Insert = {
  ...valid,
  status: 'published',
  _id: new ObjectId(),
  createdAt: new Date(),
};
// @ts-expect-error required title
const missing: Insert = {
  organizationId: new ObjectId(),
  details: { label: 'x' },
  variants: [],
  secrets: [],
};
// @ts-expect-error insert application values, not ciphertext
const storedInput: Insert = { ...valid, internalNotes: new Binary() };
// @ts-expect-error stored representation must be Binary
const storedBad: Stored['internalNotes'] = 'plaintext';
// @ts-expect-error exact optional properties require omission
const undefinedInput: Insert = { ...valid, internalNotes: undefined };
// @ts-expect-error non-nullable title
const nullInput: Insert = { ...valid, title: null };
// @ts-expect-error nested required label
const nestedBad: Insert = { ...valid, details: {} };
// @ts-expect-error select requires defaults and generated fields
const selectBad: Select = valid;
// @ts-expect-error array elements are typed
const arrayBad: Insert = { ...valid, variants: [{ sku: 'a', title: 'x', price: 'cheap' }] };
// @ts-expect-error enums preserve literals
const enumBad: Insert = { ...valid, status: 'unknown' };
// @ts-expect-error default must fit enum
Products.status.default('unknown');
// @ts-expect-error modifiers are limited to meaningful base kinds
boolean().min(1);
// @ts-expect-error only ObjectId supports auto
string().auto();
const update: Update = {
  $set: { 'details.secret': 'new', title: 'Updated' },
  $push: { secrets: { $each: ['a'] } },
};
// @ts-expect-error unknown update path
const unknownUpdate: Update = { $set: { typo: 'x' } };
// @ts-expect-error generated fields cannot be updated
const timestampUpdate: Update = { $set: { createdAt: new Date() } };
// @ts-expect-error _id is immutable
const idUpdate: Update = { $set: { _id: new ObjectId() } };
// @ts-expect-error codec uses application value
const cipherUpdate: Update = { $set: { internalNotes: new Binary() } };
const positionalUpdate: Update = { $set: { 'variants.$.secret': 'x' } };
// @ts-expect-error push only on arrays
const badPush: Update = { $push: { title: 'x' } };
// @ts-expect-error unsupported operators are not silently forwarded
const badOperator: Update = { $rename: { title: 'name' } };
const filter: Filter<typeof Products.$fields> = {
  'variants.price': { $lte: 100 },
  $or: [{ status: 'draft' }, { title: /^A/ }],
};
// @ts-expect-error invalid number operand
const badFilter: Filter<typeof Products.$fields> = { 'variants.price': { $gte: 'cheap' } };
// @ts-expect-error typo is rejected
const unknownFilter: Filter<typeof Products.$fields> = { titel: 'x' };
const db = createDatabase({
  uri: 'mongodb://localhost',
  database: 'types',
  collections: { products: Products },
});
async function operations() {
  await db.products.insertOne(valid);
  await db.products.updateOne(filter, update);
  // Runtime upsert validation still requires a complete insertion candidate.
  await db.products.updateOne({}, { $inc: { 'details.count': 1 } }, { upsert: true });
  const projected = await db.products.findOne(
    {},
    { projection: { title: 1, internalNotes: 1, _id: 0 } },
  );
  if (projected) {
    expect<Equal<typeof projected.title, string>>();
    expect<Equal<typeof projected.internalNotes, string | undefined>>();
    // @ts-expect-error _id was excluded
    projected._id;
    // @ts-expect-error not selected
    projected.status;
  }
  const excluded = await db.products.findOne({}, { projection: { internalNotes: 0 } });
  if (excluded) {
    excluded._id satisfies ObjectId;
    // @ts-expect-error excluded
    excluded.internalNotes;
  }
  const id = await db.products.findOne({}, { projection: { _id: 1 } });
  if (id) {
    id._id satisfies ObjectId;
    // @ts-expect-error only _id selected
    id.title;
  }
  const full = await db.products.findOne({});
  if (full) full.status satisfies Select['status'];
  // @ts-expect-error mixed projection
  await db.products.findOne({}, { projection: { title: 1, status: 0 } });
  // @ts-expect-error unknown projection field
  await db.products.findOne({}, { projection: { typo: 1 } });
  await db.products.findOne({}, { projection: { 'details.secret': 1 } });
}
void [defaults, operations];
const broadProjection: Projection<typeof Products.$fields> = {} as Projection<
  typeof Products.$fields
>;
// @ts-expect-error widened projections cannot promise a precise result shape
void db.products.findOne({}, { projection: broadProjection });
function plainObjectIsMutable(value: Select) {
  value.title = 'locally edited';
  value.details.label = 'changed';
}
void plainObjectIsMutable;
// A bounded dot path still permits assigning deeper documents as a whole.
import { array, collection, number, object, objectId } from '../src/index.js';
const Deep = collection('deep', {
  _id: objectId().auto(),
  a: object({ b: object({ c: object({ d: object({ e: object({ f: string() }) }) }) }) }),
});
const deepValid: Filter<typeof Deep.$fields> = { 'a.b.c.d.e': { f: 'value' } };
// @ts-expect-error dot-path expansion ends at five field segments
const deepInvalid: Filter<typeof Deep.$fields> = { 'a.b.c.d.e.f': 'value' };
const ArrayDefaults = collection('array_defaults', {
  _id: objectId().auto(),
  rows: array(object({ name: string(), count: number().default(0) })),
});
const arraysWithDefaults: typeof ArrayDefaults.$inferInsert = { rows: [{ name: 'a' }] };
const arraySelectMissingDefault: typeof ArrayDefaults.$inferSelect = {
  _id: new ObjectId(),
  // @ts-expect-error selection includes nested defaults
  rows: [{ name: 'a' }],
};
void [deepValid, arraysWithDefaults];

// Index callback references and partial predicates remain tied to the complete collection schema.
import { index, date, customType, enum_ } from '../src/index.js';
const Indexed = collection(
  'indexed',
  {
    _id: objectId().auto(),
    accountId: objectId(),
    status: enum_('draft', 'published').default('draft'),
    createdAt: date(),
    details: object({ slug: string() }).optional(),
    tags: array(object({ label: string() })),
    secret: customType({
      base: string,
      codec: {
        encode: (v: string) => new Binary(Buffer.from(v)),
        decode: (v: Binary) => v.toString(),
        storedSchema: { bsonType: 'binData' },
      },
    })(),
  },
  (t) => {
    index('valid').on(t.accountId, t.createdAt.desc()).partial({ status: 'published' });
    index('stored').on(t.secret).partial({ secret: new Binary() });
    // @ts-expect-error unknown key references cannot widen the schema
    index('unknown').on(t.missing);
    // @ts-expect-error nested path typo
    index('nested_unknown').on(t['details.missing']);
    // @ts-expect-error field builders are not index references
    index('builder').on(string());
    // @ts-expect-error raw paths are not index references
    index('raw').on('accountId');
    // @ts-expect-error at least one key is required
    index('empty').on();
    // @ts-expect-error partial predicates know the enum on fields outside the index key
    index('enum').on(t.accountId).partial({ status: 'other' });
    // @ts-expect-error partial predicate typo
    index('predicate').on(t.accountId).partial({ missing: true });
    // @ts-expect-error stored codec values, not application plaintext
    index('plaintext').on(t.secret).partial({ secret: 'plain' });
    index('absent')
      .on(t.accountId)
      // @ts-expect-error only $exists: true is supported in partial indexes
      .partial({ 'details.slug': { $exists: false } });
    index('operator')
      .on(t.accountId)
      // @ts-expect-error unsupported partial filter operator
      .partial({ status: { $ne: 'draft' } });
    index('logical')
      .on(t.accountId)
      // @ts-expect-error unknown predicates are rejected inside logical branches
      .partial({ $or: [{ typo: 1 }] });
    return [
      index('account_recent').on(t.accountId, t.createdAt.desc()),
      index('slug')
        .on(t['details.slug'])
        .unique()
        .partial({ 'details.slug': { $type: 'string', $gt: '' } }),
      index('tag').on(t['tags.label']),
    ];
  },
);
// @ts-expect-error callback use must not broaden inferred data fields
const indexedMissing: typeof Indexed.$inferInsert = { accountId: new ObjectId() };

collection('index_depth', Deep.$fields, (t) => {
  // @ts-expect-error index paths share the five-level traversal budget
  index('too_deep').on(t['a.b.c.d.e.f']);
  return [index('whole_deep_object').on(t['a.b.c.d.e'])];
});

// Field visibility affects reads only. Protected paths affect updates only.
const Private = collection('private', {
  _id: objectId().auto().select(false),
  name: string(),
  token: string().select(false).immutable().optional().nullable().default('secret'),
  profile: object({ label: string(), token: string().select(false), id: string().immutable() })
    .nullable()
    .optional(),
  rows: array(object({ id: string().immutable(), token: string().select(false) })),
  locked: object({ mutableChild: string() }).immutable(),
  lockedArray: array(string()).immutable(),
});
const privateDb = createDatabase({
  uri: 'mongodb://unused',
  database: 'types',
  collections: { private: Private },
});
type PrivateRead = typeof Private.$inferSelect;
// @ts-expect-error hidden fields are absent from default select inference
const hiddenRead: PrivateRead['token'] = 'secret';
// @ts-expect-error hidden IDs are also absent
const hiddenId: PrivateRead['_id'] = new ObjectId();
const storedToken: typeof Private.$inferStored.token = 'secret';
privateDb.private.insertOne({
  name: 'name',
  token: 'secret',
  rows: [{ id: 'a', token: 'secret' }],
  locked: { mutableChild: 'x' },
  lockedArray: [],
});
privateDb.private.updateOne(
  {},
  { $set: { 'profile.label': 'new' }, $push: { rows: { id: 'new', token: 'secret' } } },
);
// @ts-expect-error immutable scalar cannot be set, flags survive modifier chaining
privateDb.private.updateOne({}, { $set: { token: 'new' } });
// @ts-expect-error immutable descendants prevent parent replacement, even null
privateDb.private.updateOne({}, { $set: { profile: null } });
// @ts-expect-error immutable descendants prevent array replacement
privateDb.private.updateOne({}, { $set: { rows: [] } });
// @ts-expect-error immutable ancestor prevents updates to otherwise mutable children
privateDb.private.updateOne({}, { $set: { 'locked.mutableChild': 'new' } });
// @ts-expect-error immutable array cannot be appended to
privateDb.private.updateOne({}, { $push: { lockedArray: { $each: ['new'] } } });
const AlwaysLocked = collection('always_locked', {
  _id: objectId().auto(),
  token: string().immutable(),
});
// @ts-expect-error no writable paths still rejects arbitrary $set fields
const entirelyImmutable: typeof AlwaysLocked.$inferUpdate = { $set: { token: 'new' } };
const ProtectedDeep = collection('protected_deep', {
  _id: objectId().auto(),
  a: object({
    b: object({ c: object({ d: object({ e: object({ f: string().immutable() }) }) }) }),
  }),
});
// @ts-expect-error protected descendants below the dot-path budget still prevent replacement
const deepProtected: typeof ProtectedDeep.$inferUpdate = { $set: { a: {} } };
const inherited = customType({ base: () => string().immutable().select(false), metadata: {} })();
expect<Equal<typeof inherited.$types.immutable, true>>();
expect<Equal<typeof inherited.$types.selected, false>>();
// @ts-expect-error selection metadata must be known at compile time
string().select(Math.random() > 0.5);
async function privateReads() {
  const plain = await privateDb.private.findOne({ token: 'allowed filter' });
  if (plain) {
    // @ts-expect-error hidden by default
    plain.token;
    // @ts-expect-error recursively hidden
    plain.profile?.token;
    // @ts-expect-error hidden inside arrays
    plain.rows[0]!.token;
    plain.rows[0]!.id satisfies string;
  }
  const excluded = await privateDb.private.findOne({}, { projection: { name: 0, _id: 1 } });
  if (excluded) {
    excluded._id satisfies ObjectId;
    // @ts-expect-error exclusion does not opt hidden fields in
    excluded.token;
    // @ts-expect-error excluded
    excluded.name;
  }
  const included = await privateDb.private.findOne(
    {},
    { projection: { token: 1, profile: 1, rows: 1 } },
  );
  if (included) {
    expect<Equal<typeof included.token, string | null | undefined>>();
    included.profile?.token satisfies string | undefined;
    included.rows[0]!.token satisfies string;
    // @ts-expect-error hidden _id is not implicitly included
    included._id;
  }
  const id = await privateDb.private.findOne({}, { projection: { _id: 1 } });
  if (id) id._id satisfies ObjectId;
  const empty = await privateDb.private.findOne({}, { projection: {} });
  if (empty) {
    // @ts-expect-error empty projection retains defaults
    empty.token;
  }
}
void [storedToken, privateReads];

// All collection operations preserve the same application shapes and field rules.
import type { BulkOperation, Sort } from '../src/index.js';
const productSort: Sort<typeof Products.$fields> = [
  ['variants.price', -1],
  ['_id', 1],
];
const queryCursor = db.products.cursor(
  { status: 'draft' },
  {
    projection: { title: 1, _id: 0 },
    sort: productSort,
    skip: 0,
    limit: 10,
    batchSize: 2,
  },
);
queryCursor.sort({ title: 1 }).limit(2).skip(1).batchSize(1);
// @ts-expect-error cursor sort rejects unknown paths
queryCursor.sort({ typo: 1 });
// @ts-expect-error invalid direction
queryCursor.sort({ title: 'asc' });
// @ts-expect-error unknown filter
privateDb.private.exists({ missing: true });
// @ts-expect-error unknown sort path in options
privateDb.private.find({}, { sort: { missing: 1 } });
// @ts-expect-error result inference requires literal projections
privateDb.private.find({}, { projection: broadProjection });
privateDb.private.findOneAndDelete({}, { projection: { 'profile.token': 1 } });
privateDb.private.findOneAndUpdate(
  {},
  { $set: { name: 'updated' } },
  // @ts-expect-error mixed projection
  { projection: { name: 1, token: 0 } },
);
// @ts-expect-error returned-document updates protect immutable paths
privateDb.private.findOneAndUpdate({}, { $set: { token: 'updated' } });
// @ts-expect-error multi updates protect immutable parents
privateDb.private.updateMany({}, { $set: { 'locked.mutableChild': 'updated' } });
// @ts-expect-error missing required insert fields
privateDb.private.insertMany([{ name: 'incomplete' }]);
// @ts-expect-error pipeline updates are deferred
privateDb.private.updateMany({}, [{ $set: { name: 'updated' } }]);
privateDb.private.findOneAndUpdate(
  {},
  { $set: { name: 'updated' } },
  { includeResultMetadata: true },
);
privateDb.private.findOneAndUpdate({}, { $set: { name: 'updated' } }, { upsert: true });
// @ts-expect-error deliberate filter is required for deletes
privateDb.private.deleteMany();
// @ts-expect-error count options do not accept projections
privateDb.private.countDocuments({}, { projection: { name: 1 } });

const bulk: readonly BulkOperation<typeof Products.$fields>[] = [
  { insertOne: { document: valid } },
  { updateOne: { filter, update, upsert: false } },
  { updateMany: { filter, update } },
  { deleteOne: { filter } },
  { deleteMany: { filter } },
];
db.products.bulkWrite(bulk, { ordered: false });
// @ts-expect-error one operation per entry, even in a pretyped variable
const mixedBulk: BulkOperation<typeof Products.$fields> = {
  deleteOne: { filter },
  deleteMany: { filter },
};
// @ts-expect-error bulk insertion requires application values
privateDb.private.bulkWrite([{ insertOne: { document: { name: 'incomplete' } } }]);
// @ts-expect-error bulk update does not bypass immutability
privateDb.private.bulkWrite([{ updateMany: { filter: {}, update: { $set: { token: 'new' } } } }]);
// @ts-expect-error replacement is not supported
privateDb.private.bulkWrite([{ replaceOne: { filter: {}, replacement: {} } }]);
privateDb.private.bulkWrite([
  { updateOne: { filter: {}, update: { $set: { name: 'new' } }, upsert: true } },
]);
// @ts-expect-error arbitrary driver options are not silently forwarded
privateDb.private.bulkWrite([{ deleteOne: { filter: {} } }], { bypassDocumentValidation: true });

async function queryResults() {
  const items = await queryCursor.toArray();
  items[0]!.title satisfies string;
  // @ts-expect-error omitted by the projection
  items[0]!._id;
  for await (const value of privateDb.private.cursor()) {
    value.name satisfies string;
    // @ts-expect-error cursor reads hide tokens
    value.token;
  }
  const item = await privateDb.private.cursor().next();
  if (item) {
    // @ts-expect-error hidden in nested arrays
    item.rows[0]!.token;
  }
  const returned = await privateDb.private.findOneAndUpdate(
    {},
    { $set: { name: 'updated' } },
    { returnDocument: 'after', projection: { token: 1, _id: 1 }, sort: { name: 1 } },
  );
  if (returned) {
    returned._id satisfies ObjectId;
    expect<Equal<typeof returned.token, string | null | undefined>>();
    // @ts-expect-error only selected fields returned
    returned.name;
  }
  const deleted = await privateDb.private.findOneAndDelete({}, { sort: [['name', -1]] });
  if (deleted) {
    // @ts-expect-error default selection applies to deleted documents
    deleted.token;
    deleted.name satisfies string;
  }
  (await db.products.exists()) satisfies boolean;
  (await db.products.countDocuments({}, { skip: 1, limit: 2 })) satisfies number;
  (await db.products.insertMany([valid])).insertedIds[0] satisfies ObjectId | undefined;
  (await db.products.updateMany(filter, update)).modifiedCount satisfies number;
  (await db.products.deleteOne(filter)).deletedCount satisfies number;
  (await db.products.deleteMany(filter)).deletedCount satisfies number;
  (await db.products.bulkWrite(bulk)).insertedCount satisfies number;
}
void queryResults;

async function materializedReadsAndChunks() {
  const pending = privateDb.private.find({}, { projection: { name: 1, _id: 0 }, limit: 10 });
  pending satisfies Promise<{ name: string }[]>;
  // @ts-expect-error find returns a promise, not a fluent cursor
  pending.limit(2);
  const values = await pending;
  values[0]!.name satisfies string;
  // @ts-expect-error excluded from materialized results
  values[0]!._id;

  for await (const batch of privateDb.private.chunks({}, { size: 50 })) {
    batch[0]!.name satisfies string;
    // @ts-expect-error default-hidden ID remains hidden despite internal pagination
    batch[0]!._id;
    // @ts-expect-error default-hidden tokens remain hidden
    batch[0]!.token;
    // @ts-expect-error nested hidden fields are absent
    batch[0]!.rows[0]!.token;
  }
  for await (const batch of privateDb.private.chunks(
    {},
    {
      size: 50,
      afterId: new ObjectId(),
      projection: { token: 1, _id: 0 },
    },
  )) {
    expect<Equal<(typeof batch)[0]['token'], string | null | undefined>>();
    // @ts-expect-error internally fetched ID is not part of the result type
    batch[0]!._id;
    // @ts-expect-error not selected
    batch[0]!.name;
  }
  const chunks = privateDb.private.chunks({}, { size: 2, projection: { name: 1, _id: 1 } });
  const chunk = await chunks.next();
  if (!chunk.done) chunk.value[0]!._id satisfies ObjectId;
  await chunks.return();
}
// @ts-expect-error chunk size must be specified
privateDb.private.chunks({}, {});
// @ts-expect-error checkpoints use ObjectIds
privateDb.private.chunks({}, { size: 10, afterId: 'id' });
// @ts-expect-error chunks always use ascending _id order
privateDb.private.chunks({}, { size: 10, sort: { name: 1 } });
// @ts-expect-error skip is incompatible with checkpoint pagination
privateDb.private.chunks({}, { size: 10, skip: 5 });
// @ts-expect-error cannot mix projection modes
privateDb.private.chunks({}, { size: 10, projection: { name: 1, token: 0 } });
// @ts-expect-error unknown projected property
privateDb.private.chunks({}, { size: 10, projection: { typo: 1 } });
// @ts-expect-error unknown filter
privateDb.private.chunks({ typo: true }, { size: 10 });
// @ts-expect-error widened projections cannot promise an exact result
db.products.chunks({}, { size: 10, projection: broadProjection });
void materializedReadsAndChunks;

const encodedCounter = customType({
  base: number,
  codec: {
    encode: (value: number) => value * 10,
    decode: (value: number) => value / 10,
    storedSchema: { bsonType: 'number' },
  },
});
const UpdateOperators = collection('update_operators', {
  _id: objectId().auto(),
  count: number().integer(),
  title: string(),
  nullable: number().nullable(),
  defaulted: number().default(5),
  optional: number().optional().default(5),
  annotated: customType({ base: number, metadata: { unit: 'items' } })(),
  encoded: encodedCounter()
    .optional()
    .nullable()
    .default(1)
    .min(0)
    .max(100)
    .integer()
    .select(false),
  wrapped: customType({ base: encodedCounter, metadata: {} })(),
  stringEncoded: customType({
    base: number,
    codec: {
      encode: (value: number) => String(value),
      decode: (value: string) => Number(value),
      storedSchema: { bsonType: 'string' },
    },
  })(),
  details: object({ count: number(), label: string().optional() }).optional(),
  rows: array(string()).optional(),
  frozen: number().optional().immutable(),
  locked: object({ count: number().optional() }).immutable(),
  protected: object({ fixed: string().immutable() }).optional(),
  protectedRows: array(object({ fixed: string().immutable() })).optional(),
});
type OperatorUpdate = typeof UpdateOperators.$inferUpdate;
const operatorsValid: OperatorUpdate = {
  $inc: { count: 1, nullable: -1, defaulted: 2, annotated: 0, 'details.count': 1 },
  $unset: { optional: 1, encoded: '', 'details.label': true, rows: 1 },
};
const removeOptionalObject: OperatorUpdate = { $unset: { details: 1 } };
// @ts-expect-error required fields cannot be removed
const unsetRequired: OperatorUpdate = { $unset: { count: 1 } };
// @ts-expect-error nullable does not mean optional
const unsetNullable: OperatorUpdate = { $unset: { nullable: 1 } };
// @ts-expect-error defaults do not make a stored field optional
const unsetDefaulted: OperatorUpdate = { $unset: { defaulted: 1 } };
// @ts-expect-error optional ancestor does not make a required child optional
const unsetChild: OperatorUpdate = { $unset: { 'details.count': 1 } };
// @ts-expect-error only driver-compatible removal markers
const unsetMarker: OperatorUpdate = { $unset: { optional: false } };
// @ts-expect-error immutable fields cannot be removed
const unsetImmutable: OperatorUpdate = { $unset: { frozen: 1 } };
// @ts-expect-error immutable descendants prevent ancestor removal
const unsetProtected: OperatorUpdate = { $unset: { protected: 1 } };
// @ts-expect-error protection traverses arrays
const unsetProtectedRows: OperatorUpdate = { $unset: { protectedRows: 1 } };
// @ts-expect-error increment requires a number field
const incString: OperatorUpdate = { $inc: { title: 1 } };
// @ts-expect-error codecs are rejected even when storage and app values are both numbers
const incEncoded: OperatorUpdate = { $inc: { encoded: 1 } };
// @ts-expect-error metadata-only wrapping preserves the base codec restriction
const incWrapped: OperatorUpdate = { $inc: { wrapped: 1 } };
// @ts-expect-error numeric application values do not imply numeric storage
const incStringEncoded: OperatorUpdate = { $inc: { stringEncoded: 1 } };
// @ts-expect-error deltas must be numeric
const incValue: OperatorUpdate = { $inc: { count: '1' } };
// @ts-expect-error immutable fields cannot be incremented
const incImmutable: OperatorUpdate = { $inc: { frozen: 1 } };
// @ts-expect-error immutable ancestors prevent increments
const incLocked: OperatorUpdate = { $inc: { 'locked.count': 1 } };
// @ts-expect-error no positional or numeric array paths
const incArray: OperatorUpdate = { $inc: { 'rows.0': 1 } };
// @ts-expect-error unknown paths remain rejected
const unsetUnknown: OperatorUpdate = { $unset: { typo: 1 } };
const NoOperators = collection('no_operators', { title: string().immutable() });
// @ts-expect-error schemas with no eligible paths do not widen to arbitrary keys
const incNoPaths: typeof NoOperators.$inferUpdate = { $inc: { title: 1 } };
// @ts-expect-error schemas with no eligible paths do not widen to arbitrary keys
const unsetNoPaths: typeof NoOperators.$inferUpdate = { $unset: { title: 1 } };

const operatorDb = createDatabase({
  uri: 'mongodb://unused',
  database: 'unused',
  collections: { records: UpdateOperators },
});
operatorDb.records.updateOne({}, operatorsValid);
operatorDb.records.updateMany({}, operatorsValid);
operatorDb.records.findOneAndUpdate({}, operatorsValid, { projection: { count: 1 } });
operatorDb.records.bulkWrite([
  { updateOne: { filter: {}, update: operatorsValid } },
  { updateMany: { filter: {}, update: operatorsValid } },
]);

const Discovery = collection('discovery', {
  _id: objectId().auto(),
  status: enum_('draft', 'published'),
  optional: string().optional(),
  nullable: number().nullable().optional(),
  dates: array(date()),
  hidden: string().select(false),
  profile: object({ label: string(), hidden: string().select(false) }).optional(),
  rows: array(object({ label: string().optional(), tags: array(string()) })),
  matrix: array(array(number())),
  secret: encodedCounter(),
  secrets: array(encodedCounter()),
  protectedObject: object({ safe: string(), secret: encodedCounter() }),
});
const discoveryDb = createDatabase({
  uri: 'mongodb://unused',
  database: 'unused',
  collections: { records: Discovery },
});
discoveryDb.records.distinct('status') satisfies Promise<('draft' | 'published')[]>;
discoveryDb.records.distinct('optional') satisfies Promise<string[]>;
discoveryDb.records.distinct('nullable') satisfies Promise<(number | null)[]>;
discoveryDb.records.distinct('dates') satisfies Promise<Date[]>;
discoveryDb.records.distinct('hidden') satisfies Promise<string[]>;
discoveryDb.records.distinct('profile') satisfies Promise<{ label: string; hidden: string }[]>;
discoveryDb.records.distinct('rows.label') satisfies Promise<string[]>;
discoveryDb.records.distinct('rows.tags') satisfies Promise<string[]>;
discoveryDb.records.distinct('matrix') satisfies Promise<number[][]>;
discoveryDb.records.distinct('protectedObject.safe', { status: 'draft' }) satisfies Promise<
  string[]
>;
// @ts-expect-error schema paths are required
discoveryDb.records.distinct('typo');
// @ts-expect-error stored equality is not application equality for codecs
discoveryDb.records.distinct('secret');
// @ts-expect-error array elements have codecs
discoveryDb.records.distinct('secrets');
// @ts-expect-error returned object contains a codec
discoveryDb.records.distinct('protectedObject');
// @ts-expect-error nested codec
discoveryDb.records.distinct('protectedObject.secret');
// @ts-expect-error filter keeps schema types
discoveryDb.records.distinct('status', { status: 'invalid' });
// @ts-expect-error array numeric paths remain unsupported
discoveryDb.records.distinct('rows.0.label');
// @ts-expect-error whole array elements retain their array type
const wrongDistinctMatrix: Promise<number[]> = discoveryDb.records.distinct('matrix');

const ttlCodec = customType({
  base: date,
  codec: {
    encode: (value: Date) => value,
    decode: (value: Date) => value,
    storedSchema: { bsonType: 'date' },
  },
});
collection(
  'ttl_types',
  {
    _id: objectId().auto(),
    expiresAt: date().nullable().optional(),
    dates: array(date()),
    label: string(),
    secret: ttlCodec(),
    matrix: array(array(date())),
    nested: array(object({ expiresAt: date() })),
  },
  (t) => {
    index('expires').on(t.expiresAt.desc()).partial({ label: 'expired' }).expireAfterSeconds(0);
    index('dates').on(t.dates).expireAfterSeconds(60).sparse();
    index('nested').on(t['nested.expiresAt']).unique().expireAfterSeconds(60);
    // @ts-expect-error TTL requires dates
    index('string').on(t.label).expireAfterSeconds(1);
    // @ts-expect-error TTL requires one field
    index('compound').on(t.expiresAt, t.label).expireAfterSeconds(1);
    // @ts-expect-error codecs are not assumed to preserve expiration times
    index('codec').on(t.secret).expireAfterSeconds(1);
    // @ts-expect-error nested date arrays are not supported as TTL targets
    index('matrix').on(t.matrix).expireAfterSeconds(1);
    // @ts-expect-error seconds must be numeric
    index('seconds').on(t.expiresAt).expireAfterSeconds('60');
    return [];
  },
);

const ScalarArrays = collection('scalar_arrays', {
  labels: array(string()),
  counts: array(number()),
  tokens: array(encodedCounter()),
  fixed: array(string()).immutable(),
  fixedElements: array(string().immutable()),
  rows: array(object({ name: string() })),
});
const validArrayOperators: typeof ScalarArrays.$inferUpdate = {
  $addToSet: { labels: { $each: ['a'] } },
  $pull: { counts: { $gte: 2 } },
};
// @ts-expect-error wrong element type
const badArrayAdd: typeof ScalarArrays.$inferUpdate = { $addToSet: { counts: 'a' } };
// @ts-expect-error equality on codecs is unsupported
const badArrayCodec: typeof ScalarArrays.$inferUpdate = { $addToSet: { tokens: 1 } };
// @ts-expect-error immutable descendants cannot be removed
const badArrayRemoval: typeof ScalarArrays.$inferUpdate = { $pull: { fixedElements: 'a' } };
const validArrayObject: typeof ScalarArrays.$inferUpdate = { $pull: { rows: { name: 'a' } } };

const compareValid: typeof UpdateOperators.$inferUpdate = {
  $min: { count: 1 },
  $max: { optional: 10 },
};
// @ts-expect-error comparison cannot operate on encoded numbers
const compareCodec: typeof UpdateOperators.$inferUpdate = { $max: { encoded: 1 } };
// @ts-expect-error only numbers and dates are supported
const compareString: typeof UpdateOperators.$inferUpdate = { $min: { title: 'a' } };
// @ts-expect-error candidates cannot be null
const compareNull: typeof UpdateOperators.$inferUpdate = { $max: { nullable: null } };

const richerFilter: Filter<typeof Discovery.$fields> = {
  status: { $not: { $regex: '^draft', $options: 'i' }, $type: 'string' },
  rows: { $elemMatch: { label: { $regex: 'test' }, tags: { $all: ['a'], $size: 1 } } },
};
// @ts-expect-error array-only predicate
const badSize: Filter<typeof Discovery.$fields> = { status: { $size: 1 } };
// @ts-expect-error unknown element path
const badElem: Filter<typeof Discovery.$fields> = { rows: { $elemMatch: { typo: 1 } } };
const badElemOperand: Filter<typeof ScalarArrays.$fields> = {
  // @ts-expect-error scalar comparison retains operand type
  counts: { $elemMatch: { $gt: 'a' } },
};

const pushedWithModifiers: typeof ScalarArrays.$inferUpdate = {
  $push: {
    counts: { $each: [1], $slice: 5, $sort: -1, $position: 0 },
    rows: { $each: [{ name: 'a' }], $sort: { name: 1 } },
  },
};
const trimImmutable: typeof ScalarArrays.$inferUpdate = {
  // @ts-expect-error cannot trim immutable elements
  $push: { fixedElements: { $each: [], $slice: 1 } },
};
// @ts-expect-error scalar codecs cannot be sorted
const sortCodec: typeof ScalarArrays.$inferUpdate = { $push: { tokens: { $each: [], $sort: 1 } } };
operatorDb.records.updateOne({}, operatorsValid, { timestamps: false });
operatorDb.records.bulkWrite([
  { updateMany: { filter: {}, update: operatorsValid, timestamps: false } },
]);

discoveryDb.records.find(
  {},
  {
    collation: { locale: 'en', strength: 2 },
    hint: 'name_index',
    readPreference: 'secondaryPreferred',
  },
);
discoveryDb.records.distinct('status', {}, { hint: { status: 1 }, readPreference: 'primary' });
// @ts-expect-error write operations do not accept read preferences
operatorDb.records.updateMany({}, operatorsValid, { readPreference: 'secondary' });
// @ts-expect-error invalid read preference mode
discoveryDb.records.exists({}, { readPreference: 'invalid' });

const StringIds = collection('string_ids', { _id: string(), name: string() });
const stringDb = createDatabase({
  uri: 'mongodb://unused',
  database: 'unused',
  collections: { records: StringIds },
});
async function stringIdTypes() {
  (await stringDb.records.insertOne({ _id: 'one', name: 'One' })).insertedId satisfies string;
  (await stringDb.records.insertMany([{ _id: 'two', name: 'Two' }])).insertedIds[0] satisfies
    | string
    | undefined;
  (await stringDb.records.updateOne({ _id: 'one' }, { $set: { name: 'Changed' } }))
    .upsertedId satisfies string | null;
  for await (const batch of stringDb.records.chunks({}, { size: 10, afterId: 'one' }))
    batch[0]!._id satisfies string;
}
// @ts-expect-error string IDs require string checkpoints
stringDb.records.chunks({}, { size: 10, afterId: new ObjectId() });
// @ts-expect-error a string ID is required at insert without a default
stringDb.records.insertOne({ name: 'Missing' });

async function transactionTypes() {
  const result = await stringDb.withTransaction(async (session) => {
    await stringDb.records.insertOne({ _id: 'tx', name: 'Transaction' }, { session });
    await stringDb.records.find({}, { session });
    return 1;
  });
  result satisfies number;
  // @ts-expect-error sessions belong to a whole bulk, not individual entries
  stringDb.records.bulkWrite([{ deleteMany: { filter: {}, session: stringDb.startSession() } }]);
}

async function upsertTypes() {
  const result = await stringDb.records.findOneAndUpdate(
    { _id: 'new' },
    { $setOnInsert: { name: 'New' } },
    {
      upsert: true,
      includeResultMetadata: true,
      returnDocument: 'after',
      projection: { name: 1, _id: 0 },
    },
  );
  result.value?.name satisfies string | undefined;
  result.lastErrorObject?.updatedExisting satisfies boolean | undefined;
  // @ts-expect-error projection still applies inside metadata
  result.value?._id;
}

async function nestedProjectionTypes() {
  const selected = await discoveryDb.records.findOne(
    {},
    { projection: { 'rows.label': 1, 'profile.hidden': 1, _id: 0 } },
  );
  if (selected) {
    selected.rows[0]!.label satisfies string | undefined;
    selected.profile?.hidden satisfies string | undefined;
    // @ts-expect-error sibling field was not selected
    selected.rows[0]!.tags;
    // @ts-expect-error sibling field was not selected
    selected.profile?.label;
    // @ts-expect-error explicitly omitted
    selected._id;
  }
  const excluded = await discoveryDb.records.findOne({}, { projection: { 'rows.label': 0 } });
  excluded?.rows[0]!.tags satisfies string[] | undefined;
  // @ts-expect-error nested exclusion narrows the result
  excluded?.rows[0]!.label;
}

const positionalValid: typeof Products.$inferUpdate = {
  $inc: { 'variants.$[v].price': 1 },
  $set: { 'variants.0.secret': 'new' },
};
// @ts-expect-error element property still has its value type
const positionalWrong: typeof Products.$inferUpdate = { $inc: { 'variants.$[].secret': 1 } };
const positionalImmutable: typeof UpdateOperators.$inferUpdate = {
  // @ts-expect-error immutable element properties remain protected
  $set: { 'protectedRows.$[].fixed': 'changed' },
};
db.products.updateOne({}, positionalValid, { arrayFilters: [{ 'v.sku': 'one' }] });

import { map } from '../src/index.js';
const Maps = collection('maps', {
  _id: string(),
  counts: map(number()),
  sessions: map(object({ name: string(), count: number().default(0) })),
  secrets: map(encodedCounter()),
  fixed: map(number().immutable()),
});
const mapsDb = createDatabase({
  uri: 'mongodb://unused',
  database: 'unused',
  collections: { records: Maps },
});
const mapUpdate: typeof Maps.$inferUpdate = {
  $inc: { 'counts.session': 1 },
  $unset: { 'counts.old': 1 },
  $set: { 'sessions.new': { name: 'New' }, 'secrets.next': 5 },
};
// @ts-expect-error dynamic values retain their declared types
const mapWrong: typeof Maps.$inferUpdate = { $set: { 'counts.session': 'x' } };
// @ts-expect-error codec-backed entries cannot be incremented
const mapCodec: typeof Maps.$inferUpdate = { $inc: { 'secrets.session': 1 } };
// @ts-expect-error map value immutability prevents entry updates
const mapImmutable: typeof Maps.$inferUpdate = { $set: { 'fixed.session': 1 } };
// @ts-expect-error maps are not arrays
const mapPush: typeof Maps.$inferUpdate = { $push: { counts: 1 } };
mapsDb.records.distinct('counts.session') satisfies Promise<number[]>;
async function mapProjectionTypes() {
  const value = await mapsDb.records.findOne({}, { projection: { 'sessions.one': 1, _id: 0 } });
  value?.sessions.one?.name satisfies string | undefined;
  value?.sessions.one?.count satisfies number | undefined;
  // @ts-expect-error only the explicitly selected key is present
  value?.sessions.two;
}

const MapArrays = collection('map_arrays', { _id: string(), entries: array(map(number())) });
const mapArrayMembership: typeof MapArrays.$inferUpdate = {
  // @ts-expect-error membership operators support scalar elements, not maps
  $addToSet: { entries: { one: 1 } },
};
const mapArrayRemoval: typeof MapArrays.$inferUpdate = {
  // @ts-expect-error membership operators support scalar elements, not maps
  $pull: { entries: { one: 1 } },
};
void [mapArrayMembership, mapArrayRemoval];

const badObjectPull: typeof ScalarArrays.$inferUpdate = {
  // @ts-expect-error predicates retain the element field types
  $pull: { rows: { name: 123 } },
};

import { arrayFilter } from '../src/index.js';
arrayFilter('row', ScalarArrays.rows, { name: 'one' });
arrayFilter('count', ScalarArrays.counts, { $gte: 1 });
// @ts-expect-error selected element predicate has a string field
arrayFilter('row', ScalarArrays.rows, { name: 1 });
// @ts-expect-error unknown embedded field
arrayFilter('row', ScalarArrays.rows, { typo: true });
// @ts-expect-error scalar predicates retain their numeric type
arrayFilter('count', ScalarArrays.counts, { $gte: 'one' });
// @ts-expect-error the helper requires an array field
arrayFilter('name', string(), 'one');

// Atomic custom values retain a closed union through reusable field declarations.
const settingValue = customType({
  validate: (value: unknown): value is string | number | boolean =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
  storedSchema: { bsonType: ['string', 'number', 'bool'] },
});
const Settings = collection('settings', { _id: string(), value: settingValue() });
expect<Equal<typeof Settings.$inferSelect.value, string | number | boolean>>();
const invalidSetting: typeof Settings.$inferInsert = {
  _id: 'one',
  // @ts-expect-error opaque custom fields preserve the declared union
  value: { arbitrary: true },
};
// @ts-expect-error custom unions do not acquire string-only constraints
settingValue().pattern(/x/);
