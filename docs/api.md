# API reference

```ts
import { ObjectId } from 'mongodb';
import {
  array,
  collection,
  createDatabase,
  customType,
  discoverMetadata,
  enum_,
  jsonSchema,
  number,
  object,
  objectId,
  string,
  timestamps,
} from 'mica-mongodb';
import { encrypted } from '../examples/fields/encrypted.js';

const translatable = customType({
  base: string,
  metadata: { translatable: true },
});

const Organizations = collection('organizations', {
  _id: objectId().auto(),
  name: string(),
});
const Products = collection('products', {
  _id: objectId().auto(),
  organizationId: objectId().references(() => Organizations._id),
  title: translatable().min(1).max(200),
  status: enum_('draft', 'published').default('draft'),
  details: object({ label: translatable(), secret: encrypted().optional() }),
  variants: array(object({ sku: string(), price: number().min(0) })),
  internalNotes: encrypted().max(500).optional(),
  ...timestamps(),
});

type Product = typeof Products.$inferSelect;
type NewProduct = typeof Products.$inferInsert;
type StoredProduct = typeof Products.$inferStored; // internalNotes?: Binary
// MongoDB operator document, with application values:
type ProductUpdate = typeof Products.$inferUpdate;

const db = createDatabase({
  uri: 'mongodb://127.0.0.1:27017',
  database: 'example',
  collections: { products: Products },
  events: {
    connected(event) {
      console.log(event.status);
    },
    disconnected(event) {
      console.log(event.status);
    },
    reconnected(event) {
      console.log(event.status);
    },
    error(error) {
      console.error(error);
    },
  },
});

await db.connect(); // client.connect() and a successful primary-targeted ping
try {
  console.log(db.status); // 'connected'
  // Explicit setup for a NEW collection; not an implicit migration.
  await db.client.db('example').createCollection('products', {
    validator: jsonSchema(Products),
  });
  const { insertedId } = await db.products.insertOne({
    organizationId: new ObjectId(),
    title: 'Example',
    details: { label: 'Details', secret: 'nested secret' },
    variants: [],
    internalNotes: 'private',
  });
  await db.products.updateOne(
    { _id: insertedId },
    {
      $set: { 'details.secret': 'changed', internalNotes: 'updated' },
      $push: { variants: { sku: 'sku-1', price: 25 } },
    },
  );
  const result = await db.products.findOne(
    { _id: insertedId },
    {
      projection: { title: 1, internalNotes: 1, _id: 0 },
    },
  ); // { title: string; internalNotes?: string } | null
  console.log(result); // plain object, decrypted values
  console.log(discoverMetadata(Products, 'translatable'));
  // [{ path: 'title', value: true }, { path: 'details.label', value: true }]
} finally {
  await db.close();
}
```

[examples/quickstart.ts](../examples/quickstart.ts) is an executable demonstration that creates and deletes its own uniquely named database:

```sh
MICA_EXAMPLE_URI=mongodb://127.0.0.1:27017 npx tsx examples/quickstart.ts
```

### Field vocabulary

`string()`, `number()`, `boolean()`, `date()`, `objectId()`, `binary()`, `object(fields)`, `array(field)`, `map(valueField)`, `enum_(...values)`.

Fields are required by default. `.optional()` allows omission; `.nullable()` allows explicit null. Insert inputs may omit `.default(valueOrFactory)` and generated fields, including `_id: objectId().auto()`. Defaulted and generated values remain required on select/storage types unless also marked optional. Embedded documents receive no implicit `_id`. Values are mutable plain application objects.

`.min()`/`.max()` constrain strings, numbers, and arrays; `.pattern()` accepts a flagless RegExp on strings; `.integer()` constrains numbers; `.auto()` applies only to ObjectId. Modifiers produce new builders. `.references(() => Collection.field)` stores a lazy metadata callback and never queries another collection.

String and array length bounds must be nonnegative safe integers; numeric bounds must be finite. Field names cannot contain null bytes. Sparse insertion arrays and sparse `$each` operands are rejected rather than stored with implicit null elements.

`...timestamps()` fills missing `createdAt` and `updatedAt` on insert with the same application-clock instant. Explicit insertion values are honored. Updates set the top-level `updatedAt`; direct writes to generated fields and `_id` are rejected. Use timestamps at collection level in this spike. Embedded timestamp propagation is not implemented.

### Read shapes and immutability

```ts
const Accounts = collection('accounts', {
  _id: objectId().auto(),
  externalId: string().immutable(),
  accessToken: encrypted().optional(),
});
```

Reads include all schema fields by default. `$inferSelect` describes the complete application shape, including decoded codec values. Use an explicit 0/1 projection to include or exclude fields for a query; MongoDB excludes omitted values before Mica decodes them. Empty projections return the complete shape. Nested object/array projections remain fully inferred, and `_id` follows MongoDB’s projection rules. Encryption does not change the read shape.

`.immutable()` allows insertion but rejects subsequent updates, including writes through immutable parents and whole-object/array replacements containing protected descendants. Mutable siblings remain writable. `$push` can insert new elements with immutable children unless the array itself is immutable. Both TypeScript and runtime checks enforce these rules; returned objects remain mutable. Raw driver operations bypass them.

See [ADR 008](decisions/008-immutable-fields.md) for projection edge cases, enforcement limits, and the next query APIs.

### Custom types

`customType({ base, metadata })` creates semantic types without persistence side effects. `customType({ base, metadata?, codec: { encode, decode, storedSchema } })` changes storage representation. Both return reusable field factories that retain base modifiers. See the [AES-256-GCM example](../examples/fields/encrypted.ts); cryptography and keys belong to the application.

Codecs are synchronous, operate on a complete non-null scalar value, and must return their declared representation. The toolkit validates application constraints before encoding. Null is handled by the nullable wrapper without invoking the codec. MongoDB validators use `storedSchema`, so `.max(500)` on an encrypted string is checked before encryption, not applied to binary ciphertext. Codec output schemas are application-supplied and are not revalidated in JavaScript. Install the generated server validator to enforce stored shape.

Composite and stacked codec definitions are rejected. Compose scalar codecs inside `object()` and `array()` instead. Defaults, codecs, and metadata discovery never perform translation or application jobs.

### Typed index declarations

The optional third argument to `collection()` defines indexes alongside fields:

```ts
const Articles = collection(
  'articles',
  {
    _id: objectId().auto(),
    organizationId: objectId(),
    status: enum_('draft', 'published'),
    details: object({ slug: string().optional() }),
    ...timestamps(),
  },
  (t) => [
    index('organization_recent').on(t.organizationId, t.createdAt.desc()),
    index('published_slug')
      .on(t.organizationId, t['details.slug'])
      .unique()
      .partial({ status: 'published', 'details.slug': { $type: 'string' } }),
  ],
);
```

Import `index` from Mica with the field builders. Keys default to ascending; `.asc()` and `.desc()` make direction explicit. `.unique()`, `.sparse()`, `.partial(filter)`, and `.expireAfterSeconds(seconds)` return new declarations. Nested objects and embedded arrays use typed dotted paths, bounded to the same five traversal levels as filters. Custom maps remain atomic. Callback references are collection-scoped; field builders and raw path strings cannot be passed to `.on()`.

`Collection.$indexes` returns fresh native driver specifications. Apply them deliberately after connecting:

```ts
await db.client.db('example').collection(Articles.$name).createIndexes(Articles.$indexes);
```

Neither importing a schema nor connecting creates indexes. No automatic synchronization, dropping, or rebuilding is provided. Existing deployments must assess index changes and resolve duplicate data before creating unique indexes.

Partial filters are typed against **stored values**, including fields outside the index keys. They do not invoke defaults, codecs, or application validation. Supported predicates are equality, `$eq`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$exists: true`, `$type` aliases, `$and`, and `$or`. Runtime checks reject unknown paths, unsupported operators, duplicate names/keys, and sparse/partial combinations. MongoDB remains responsible for data-dependent and server-specific restrictions such as parallel arrays in compound multikey indexes. See [MongoDB's partial index documentation](https://www.mongodb.com/docs/manual/core/index-partial/).

TTL indexes use `.expireAfterSeconds(seconds)` on a single date field or date array without codecs. Zero means expire at that date; positive seconds specify retention after it. Deletion is asynchronous. See the separate [outbox entity](../examples/entities/outbox-events.ts) for partial seven-day retention and [ADR 012](decisions/012-distinct-and-ttl.md) for supported targets. Text, geospatial, hashed, wildcard, collation, and other index options remain available only through explicit native driver use. Single-field `_id` indexes are server-owned and cannot be declared here; `_id` can participate in compound indexes. See [ADR 007](decisions/007-typed-index-declarations.md) for the implementation boundary.

### Query and write contract

Explicit undefined values and sparse arrays in filters are rejected before BSON serialization, including nested predicates and array filters. Omit a predicate deliberately when it should not constrain a query; use explicit null when matching MongoDB's null/missing semantics. Scalar `$pull` predicates follow the same rule. These checks prevent serialization from silently changing a query; they do not replace the documented TypeScript operand types with comprehensive runtime type checking.

`aggregate(options?)` creates an immutable typed pipeline builder; `.toArray()` executes it and returns an inferred array. See [aggregation](#aggregation) for supported stages and codec behavior.

| Surface                                                       | Current behavior                                                                                                                                                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `find(filter?, options?)`                                     | Promise of a decoded array; projection, sort, skip, limit, batchSize                                                                                                                                |
| `cursor(filter?, options?)`                                   | Lazy decoding cursor with fluent configuration and async iteration                                                                                                                                  |
| `chunks(filter, { size, projection?, afterId? })`             | Async iterator of projected arrays; ascending `_id` pagination                                                                                                                                      |
| `findOne(filter?, { projection?, sort? })`                    | Plain application object or null                                                                                                                                                                    |
| `distinct(path, filter?)`                                     | Inferred value array; nested paths and array elements; codec-backed targets reject                                                                                                                  |
| `exists(filter?)`                                             | Boolean; first match, `_id` only, no decoding                                                                                                                                                       |
| `countDocuments(filter?, { skip?, limit? })`                  | Matching document count; no decoding                                                                                                                                                                |
| `insertOne(document)` / `insertMany(documents, { ordered? })` | Validate, fill defaults/generated fields, encode; native insertion results                                                                                                                          |
| `updateOne` / `updateMany`                                    | Typed filter and update; native results; validated upserts with `$set`/`$setOnInsert`/`$inc`; update timestamp control                                                                              |
| `deleteOne(filter)` / `deleteMany(filter)`                    | Native deletion results; an explicit filter is required                                                                                                                                             |
| `findOneAndUpdate(filter, update, options?)`                  | Decoded document or null; projection, sort, `returnDocument` (default `'before'`), validated upserts                                                                                                |
| `findOneAndDelete(filter, options?)`                          | Decoded deleted document or null; projection and sort                                                                                                                                               |
| `bulkWrite(operations, { ordered? })`                         | Insert/update/delete entries; validates and encodes the whole batch before sending it                                                                                                               |
| Filters                                                       | Equality, RegExp, `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$all`, `$size`, `$not`, `$type`, `$regex`/`$options`, `$elemMatch`, logical branches; bounded dotted paths |
| Codec filters and sorts                                       | Structural predicates and safe nested element predicates; codec value comparisons/sorts reject                                                                                                      |
| Updates                                                       | `$set`, `$push`/`$each`, `$unset`, `$inc`, `$min`, `$max`, scalar `$addToSet`, scalar/object `$pull`; immutable fields and containers with protected descendants reject                             |
| Projections                                                   | Literal nested `0`/`1`, inclusion/exclusion, `_id` exception                                                                                                                                        |

```ts
const page = await db.products.find(
  { status: 'published' },
  {
    projection: { title: 1, status: 1 },
    sort: [
      ['createdAt', -1],
      ['_id', -1],
    ],
    skip: 20,
    limit: 20,
  },
);

for await (const product of db.products.cursor({ status: 'published' })) {
  console.log(product.title);
}

for await (const batch of db.products.chunks(
  { status: 'published' },
  { size: 500, projection: { title: 1, _id: 0 } },
)) {
  console.log(batch.map((product) => product.title));
}

const organizations = await db.products.distinct('organizationId', { status: 'published' });

const anyDrafts = await db.products.exists({ status: 'draft' });
const total = await db.products.countDocuments({ status: 'published' });

await db.products.updateMany(
  { status: 'draft' },
  { $set: { internalNotes: 'Checked by the application' } },
);

await db.products.updateOne(
  { _id: productId },
  {
    $inc: { 'details.count': 1 },
    $unset: { description: 1, internalNotes: 1 },
  },
);

const updated = await db.products.findOneAndUpdate(
  { _id: productId },
  { $set: { title: 'Updated title' } },
  { returnDocument: 'after', projection: { title: 1 } },
);
```

`distinct` returns unique values using MongoDB equality and supports the same typed filters. Missing fields contribute no value; arrays contribute elements and nulls remain null. Targets containing codecs reject. Results have no ordering guarantee and must fit the native command result limit.

Use `find` for an array and `cursor` for streaming. Cursor options can be supplied to `cursor` or configured fluently before reading. Use `next()`, `toArray()`, or `for await...of`; one consumer at a time. `toArray()` collects remaining results. Early loop exit and failures close the cursor; explicitly `close()` unused cursors. Zero `limit` means unlimited. Sort with a unique final key for stable pagination.

`chunks` reads fresh pages in ascending `_id` order, with no open cursor between batches and no upfront count. Projections work even with `_id: 0`: Mica retains the pagination ID internally without exposing it. Use `break` to stop. To resume, supply `afterId` and explicitly select `_id` when saving checkpoints after successful processing. Scans are not snapshots; concurrent changes can affect later pages. See [ADR 010](decisions/010-find-cursor-and-chunks.md) for details and migration from the previous cursor-returning `find`.

`insertMany` and `bulkWrite` validate the full input before sending writes. Both accept `ordered` (default true). Server errors can still leave partial writes; native errors/results are preserved. Returned-document writes default to the pre-update document; use `returnDocument: 'after'` for the updated document. See [ADR 009](decisions/009-query-and-batch-operations.md) for supported bulk shapes, cursor behavior, and error semantics.

`$unset` removes optional fields without invoking codecs or restoring defaults. Required fields and containers with immutable descendants cannot be removed. `$inc` supports writable numbers without codecs, with finite deltas and integer deltas for integer fields. It creates missing values from the delta and fails on stored `null`. Result bounds such as `.min()`/`.max()` require an installed MongoDB validator; Mica performs no preliminary read. See [ADR 011](decisions/011-unset-and-increment.md).

Unknown write fields, undefined values, unsupported operators/options, conflicting update paths, and invalid positional selectors are rejected before driver execution. Omit optional values instead of supplying `undefined`. Compile-time excess-property checks are not a runtime security boundary; write validation remains active for JavaScript/cast callers.

Literal projection values are required (`as const` for reused variables). Widened/dynamic projections, projection expressions, projection `$slice`, and partial codec values are deferred. Numeric, `$`, `$[]`, and filtered `$[identifier]` array writes are supported, with schema-checked `arrayFilters`. Dot-path typing is bounded to five schema traversal levels, counting array traversal; deeper structures remain usable as complete values. Concrete object schemas retain exact paths; declared maps expose typed dynamic entry paths.

### Dynamic maps

`map(number())` provides typed counters addressed as `counts.sessionId`. `map(object(...))` provides structured values addressed as complete entries. Dynamic keys are validated, and generated MongoDB validators describe every entry's stored shape. Use an explicit query projection to include or exclude a map when needed. See the separate [browser-usage entity](../examples/entities/browser-usage.ts) and [map contract](decisions/021-dynamic-maps.md).

### Sessions, transactions, IDs, and update options

Schemas may use ObjectId or string IDs; insertion results and chunk checkpoints infer the schema's ID type. String-ID chunks require simple collation. Read operations accept collation, hints, and read preference; applicable writes accept collation and hints. Updates accept `timestamps: false` to leave automatic `updatedAt` unchanged.

```ts
await db.withTransaction(async (session) => {
  await db.products.updateOne({ _id: productId }, { $inc: { 'details.count': 1 } }, { session });
});
```

Pass the session to every participating operation. The driver owns transaction retries; callbacks may run again. Use `db.startSession()` when managing a session directly and end it after all cursors/chunks finish.

Upserts accept equality filters with `$set`, `$inc`, and top-level `$setOnInsert`. Incremented fields start from the equality-filter value or zero, overriding their insertion default; overlapping update paths reject. Mica validates the full insertion candidate, including required fields, defaults, and codecs, before sending any write. `findOneAndUpdate` can return `{ value, lastErrorObject, ok }` with `includeResultMetadata: true`; its `value` still follows projection and decoding rules.

### Deadlines, cancellation, and errors

Reads and writes accept `{ timeoutMS, maxTimeMS, signal }`. `timeoutMS` is the driver operation budget; `maxTimeMS` limits server processing. When client-side timeout is enabled, the driver controls the effective server limit. For chunks, each page gets a fresh budget; a shared `AbortSignal` can stop the whole traversal. Native cursor timeout semantics apply to cursors. Cancelled writes may already have committed. The pinned driver has a [retry-selection timeout limitation](stress-testing.md#observed-driver-timeout-limitation): `timeoutMS` alone can be exceeded during majority loss; a shared abort signal bounded cancellation in the recovery test.

```ts
const controller = new AbortController();
const rows = await db.products.find({}, { timeoutMS: 2000, signal: controller.signal });
```

Input validation throws `MicaValidationError` with a stable `code` and field/operation `path`. Native MongoDB errors and application codec exceptions retain their original identity. See [validation errors](decisions/022-validation-errors.md) and [execution options](decisions/023-execution-budgets.md).

Embedded-object removal and typed array filters use element-relative predicates:

```ts
import { arrayFilter } from 'mica-mongodb';

await db.products.updateOne({ _id: productId }, { $pull: { variants: { sku: 'retired' } } });

await db.products.updateOne(
  { _id: productId },
  { $set: { 'variants.$[variant].price': 25 } },
  { arrayFilters: [arrayFilter('variant', Products.variants, { sku: 'standard' })] },
);
```

`$pull` rejects removal of immutable/generated descendants and comparisons against codec-backed values. The optional `arrayFilter` helper infers predicate types from the selected array; identifier matching still receives runtime validation. See [object removal](decisions/024-object-pull.md), [incrementing upserts](decisions/025-increment-upserts.md), and [typed array filters](decisions/026-typed-array-filters.md).

### Connection and raw access

`db.status` is the only state API: `idle | connecting | connected | disconnected | closing | closed`. Operations and sessions require an initial successful explicit `connect()`. After that, transient topology loss does not block calls at the Mica boundary: the driver applies server selection, operation deadlines, and transaction retry rules. Calls before the initial connection or while closing/closed are rejected. Concurrent connects/closes coalesce; `closed` is terminal. A failed initial connection can be retried with `connect()`. Supply `client: existingMongoClient` instead of `uri` when driver options are needed. The database owns closing that supplied client; use one toolkit database per client, with standard BSON deserialization settings.

After initial connection, loss of all known writable servers emits `disconnected`; recovery requires a successful primary-targeted ping before `reconnected`. Losing only a secondary does not disconnect while a primary remains. `close()` emits `disconnected` when closing a connected instance. Lifecycle callback exceptions are reported to `error`; callbacks are synchronous. Operation errors are returned through their promises. See [ADR 004](decisions/004-connection-lifecycle.md) for boundaries.

Exactly one native escape route is documented:

```ts
const raw = db.client.db('example').collection<typeof Products.$inferStored>('products');
```

**Raw writes bypass toolkit codecs, defaults, timestamps, immutability, and application validation. Raw reads return stored values without codec decoding.** Replacement writes, update pipelines, unsupported operators, and aggregation stages beyond the typed builder remain available through this route. Validated upserts and explicit sessions/transactions are described in the decisions below. For raw operations, persistence semantics are the caller's responsibility; Mica does not apply codecs or validation to raw driver calls.

### Aggregation

Build a pipeline with types inferred at each stage. No result interface or assertion is needed:

```ts
const summary = await db.products
  .aggregate({ allowDiskUse: true, maxTimeMS: 5000 })
  .match({ organizationId })
  .group({
    _id: '$status',
    products: { $sum: 1 },
    totalCount: { $sum: '$details.count' },
  })
  .match({ products: { $gte: 2 } })
  .sort({ products: -1, _id: 1 })
  .project({ products: 1, totalCount: 1, _id: 0 })
  .toArray();
// { products: number; totalCount: number }[]
```

Each stage checks the current shape. After grouping, `status` is no longer an input path; `_id`, `products`, and `totalCount` are. After the final projection, `_id` is unavailable too. Nested projections preserve the surviving object and array fields and their codecs.

Aggregation `match()` accepts an `ObjectId` or a 24-character hexadecimal string for an ObjectId field:

```ts
const products = await db.products
  .aggregate()
  .match({ organizationId: '507f1f77bcf86cd799439011' })
  .toArray();
// organizationId is still an ObjectId in the result.
```

Conversion uses the current stage's schema, including after projection or grouping. Grouping by a string field makes the new `_id` a string, so a later match leaves it unchanged even if it looks like an ObjectId. Direct comparisons, `$in`/`$nin`, `$not`, logical branches, nested object/array literals, `$all`, and `$elemMatch` share this behavior. Uppercase hex is accepted; malformed ObjectId strings throw `MicaValidationError` with the field path before querying. Control operands such as `$type`, `$exists`, and `$size` remain unchanged.

This is limited to ObjectId values in the typed aggregation builder's match inputs. Ordinary queries and writes retain their existing input types; raw pipelines are not cast. String fields and atomic custom values are not guessed from their contents. Codec comparisons remain unsupported, and no number/date coercion is introduced. `AggregateFilter<F>` is exported for reusable match predicates; result types still contain ObjectIds.

| Method                       | Contract                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `match(filter)`              | The supported typed filter vocabulary, applied to the current stage's fields                           |
| `project(projection)`        | Literal `0`/`1` inclusion or exclusion with the `_id` exception; narrows subsequent stages and results |
| `group({ _id, ...outputs })` | `_id` is `null` or a codec-free scalar `'$path'`; outputs are supported accumulators                   |
| `sort(sort)`                 | Current field paths with directions `1`/`-1`; codec-backed values reject                               |
| `skip(n)`                    | Nonnegative safe integer                                                                               |
| `limit(n)`                   | Positive safe integer; unlike `find`, zero is rejected                                                 |
| `count('total')`             | Replaces the shape with `{ total: number }`; the alias must be a single string literal                 |
| `toArray()`                  | Executes a fresh aggregate command and collects decoded plain objects                                  |

Group accumulators support `$sum: '$numericPath'`, `$sum: finiteNumber`, and `$avg`/`$min`/`$max` of numeric field references. Use `{ $sum: 1 }` to count documents within a group. Sums infer `number`; averages, minima, and maxima infer `number | null` because a group may have no numeric values. Missing or null group keys become `null`, reflected in the inferred key type. Empty input yields no group/count document, so `.count('total').toArray()` returns `[]`, not `[{ total: 0 }]`.

Count aliases cannot be `_id`, empty, start with `$`, or contain dots; prototype-related names are also rejected.

Builder methods return new pipelines. Reuse a base pipeline for independent queries; caller mutation of supplied filters, projections, group definitions, or options does not alter it. Building stages sends no query. An explicit database connection is required to create and execute a builder. It is not a thenable: call `.toArray()`. Aggregate streaming is not exposed yet; bound large results with stages or use the native driver when streaming is required.

`aggregate()` accepts `session`, `timeoutMS`, `maxTimeMS`, `signal`, `collation`, `hint`, `readPreference`, `allowDiskUse`, and a positive `batchSize`. Sessions and cancellation follow the same contracts as other queries. Driver and codec errors retain their identity, and the internal cursor is closed after execution or failure.

MongoDB evaluates stages against stored values. Mica does not run codecs inside the server pipeline. Codec value comparisons, sorts, group keys, and numeric accumulators reject; projecting an unchanged codec field remains supported and decodes it after execution. A grouped output with the same name as an original field uses the new output schema, not the original codec.

Aggregation returns all surviving fields unless a `project()` stage explicitly removes them. Whole-container inclusion returns its complete application value, and codecs run only for fields returned by the pipeline. Group references can use supported codec-free fields in the current stage.

The initial builder supports the stages above, scalar group keys, numeric accumulators, and whole-map projections. Individual map-entry projections, group references through arrays/maps, compound group keys, computed projections, arbitrary expressions, `$unwind`, `$lookup`, `$facet`, `$out`, and `$merge` are outside this API. There is no raw-stage escape inside a typed pipeline that could invalidate its inferred shape. Use a separate [raw driver query](#connection-and-raw-access) for unsupported pipelines, taking responsibility for stored types, decoding, and field selection. See [ADR 027](decisions/027-typed-aggregation.md) for the design.
