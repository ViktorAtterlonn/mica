# ADR 009 — Queries, decoding cursors, and batch operations

## Decision

The collection interface now exposes `find`, `findOne`, `exists`, `countDocuments`, `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `findOneAndUpdate`, `findOneAndDelete`, and `bulkWrite`.

Collection operations live in `packages/db/src/collection.ts`; `packages/db/src/database.ts` owns connection lifecycle and binding. Every method uses the same field definitions, filter checks, insertion/update codecs, explicit projection checks, and immutable-path enforcement. Options are explicitly supported and validated rather than forwarded wholesale to the driver. The raw MongoClient remains the deliberate escape route.

## Reads and cursors

**Read API superseded by [ADR 010](010-find-cursor-and-chunks.md):** `find` now returns a promise of an array; the lazy cursor described below is exposed as `cursor`. `chunks` adds projected `_id` pagination. The write contracts in this decision remain current.

`find(filter?, options?)` returns a lazy typed cursor. Creating one validates and snapshots filters, projection, and sort without issuing a find command. BSON serialization snapshots filters, retaining BSON numeric types so later caller mutation cannot bypass the checked filter. Options support `projection`, `sort`, `skip`, `limit`, and `batchSize`.

The cursor supports `next()`, `toArray()`, `for await...of`, `close()`, and `closed`. Fluent `.sort()`, `.skip()`, `.limit()`, and `.batchSize()` can configure it before consumption. It holds a native driver cursor and decodes each returned document. It does not expose driver methods that could bypass decoding or change the projected result type.

Consumption is sequential. Overlapping consumption rejects; an active iterator owns the cursor until completed or closed. `toArray()` collects remaining results, so consuming one item with `next()` first excludes that item from the resulting array. Early loop exit, exhaustion, and query/codec failures close the cursor. Close is terminal; subsequent reads return null/empty results. Configure before consumption. Close an unused cursor explicitly. The connection must be ready when creating a cursor and before reading an open cursor.

`findOne` also supports sorting. Read methods use the projection behavior from [ADR 019](019-nested-projections.md): explicit projections happen on the server before decoding; unprojected reads return the complete application shape. Returned values and cursor elements infer the selected application shape.

Sorts accept objects or ordered `[path, 1 | -1]` pairs and share the filter path budget. Ordered pairs preserve compound order even for numeric-looking field names. Unknown paths, duplicate pairs, other directions, and codec-backed fields or their containers are rejected. Sorting ciphertext would not represent application-value ordering. `skip` and `limit` are nonnegative safe integers; zero limit means no limit. `batchSize` is a positive safe integer. Use a unique final sort key such as `_id` for stable ordering when paginating.

`exists(filter?)` returns a boolean using a single-match native query projecting only `_id`, independently of the schema's `_id` selection setting. It never decodes. This is distinct from the existing `$exists` field predicate. `countDocuments(filter?, { skip?, limit? })` counts matching stored documents without materialization or codecs. Both retain filter restrictions, including rejecting value comparisons on codec-backed fields.

The cursor follows the official driver's [cursor consumption and resource model](https://www.mongodb.com/docs/drivers/node/current/crud/query/cursor/), while limiting its surface to preserve Mica's inference and decoding guarantees.

## Writes and returned documents

`insertMany` validates and encodes every input before invoking the driver. Each document receives its own generated IDs and defaults; timestamps share one application-clock instant for the call. Inputs are not mutated. `updateMany` uses the same update encoder as `updateOne`; generated `updatedAt` uses one instant for all matched documents. Results are native driver insertion/update/deletion results.

`deleteOne` and `deleteMany` require an explicit filter; `{}` deliberately targets any/all documents. They delete stored documents directly. Immutability protects field updates, not document deletion. No application lifecycle policies run.

`findOneAndUpdate` returns a decoded plain document or null. It accepts `projection`, `sort`, and `returnDocument: 'before' | 'after'`; the default is `'before'`, matching the driver. `findOneAndDelete` returns the decoded deleted document or null with projection and sort support. Both force the plain-document result mode internally. If decoding fails after a write, the write may already have succeeded; Mica propagates the error without replaying the operation.

## Bulk writes and errors

`bulkWrite(operations, { ordered? })` accepts exactly one of `insertOne`, `updateOne`, `updateMany`, `deleteOne`, or `deleteMany` in each entry. Insert payloads use inferred insert types; filters and updates use the same types as individual operations. Empty and sparse batches, malformed payloads, and unsupported options reject.

All entries are validated and encoded before sending any write. Invalid input anywhere, including an immutable-path violation, therefore prevents the entire batch from reaching MongoDB even with `ordered: false`. This guarantee covers toolkit preflight failures; it does not make the server execution transactional. A single timestamp is used for the whole call, while generated IDs/default factories execute per inserted document.

Both `insertMany` and `bulkWrite` default to `ordered: true`. Server errors retain native behavior: ordered batches stop after a failing operation, while unordered batches can execute other operations. Native `MongoBulkWriteError` and its partial result are preserved. Mica adds no batch retries or rollback; configured driver behavior still applies. The [driver's bulk documentation](https://www.mongodb.com/docs/drivers/node/current/crud/bulk-write/) describes those error/result semantics.

## Limits and evidence

Updates support `$set`, `$push`, and `$each`, with `$unset` and `$inc` added in [ADR 011](011-unset-and-increment.md). Subsequent decisions add [array operators](013-array-operators.md), [query options](015-operation-options.md), [sessions/transactions](017-sessions-and-transactions.md), [validated upserts](018-upserts.md), and [positional writes](020-positional-updates.md). Replacements, pipelines, and aggregation remain deferred. Neither projection nor immutability is database authorization; raw access bypasses these toolkit rules. Tests use disposable local databases.

Compile-only tests cover all methods, projected cursor and returned-document inference, sorting, bulk operation shapes, and rejection of immutable/unsupported writes. Unit tests cover connection readiness, overlapping cursor consumers, and cleanup on failures. Real MongoDB tests in `tests/queries.integration.ts` use the disposable `mica_queries` database, inspect commands for projections/no-write preflight, cross batch boundaries, confirm cursor cleanup, verify codecs/defaults/timestamps, and exercise ordered/unordered duplicate-key failures with partial results.
