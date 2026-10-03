# ADR 010 — Array reads, explicit cursors, and projected chunks

## Decision

String-ID checkpoints and simple-collation ordering are added in [ADR 016](016-string-ids.md), operation options in [ADR 015](015-operation-options.md), and nested projections in [ADR 019](019-nested-projections.md).

`find(filter?, options?)` returns a real `Promise<Document[]>`. Ordinary reads use `await` and configure projection, sort, skip, limit, and optional transport batch size through the options object. Reawaiting the returned promise observes the same result; it does not repeat the query. All matching results are collected in memory, subject to the query's limit.

`cursor(filter?, options?)` exposes the existing lazy decoding cursor from ADR 009. Use it for streaming, fluent sort/skip/limit/batchSize configuration, `next()`, `toArray()`, or async iteration. Its cleanup, projection inference, and sequential-consumption rules are unchanged. This replaces the previous cursor-returning `find` API: change `find(...).toArray()` to `await find(...)`, or use `cursor(...)` when streaming/fluent configuration is intended.

`chunks(filter, { size, projection?, afterId? })` returns a lazy async generator of nonempty document arrays. `size` is required and must be a positive safe integer. Each page uses a fresh query sorted by `_id: 1`, limited to `size`. After the first page, the next query intersects the original filter with `_id > lastId` using `$and`, preserving all existing ID restrictions. `afterId` starts strictly after a supplied ObjectId, including on the first page.

`break`/iterator return stops iteration. Call `countDocuments` separately when a progress estimate is useful. Processing and checkpoint persistence remain application responsibilities.

## Projections and checkpoints

All three methods share literal projection typing and application-value decoding. Chunk projections can include or exclude fields and can specify `_id: 0`. Internally, chunks fetch `_id` for ordering and progress, copy the last ID before yielding, then remove `_id` before decoding if the caller’s projection excludes it. Inferred result types reflect the outward projection exactly. Explicitly selecting an object still includes its complete contents.

The filter, projection, size, and initial checkpoint are captured at iterator construction. Mutating the arguments or yielded documents/arrays cannot redirect pagination. Stored IDs encountered during traversal must be strictly increasing ObjectIds, matching Mica's collection contract; malformed IDs cause an explicit error.

For resumable processing, explicitly include `_id` in the projection and persist the last ID only after the batch completes successfully. A crashed process can replay an incompletely checkpointed batch; Mica does not claim exactly-once processing. A projection that excludes `_id` works for traversal but intentionally gives the application no ID to save as a checkpoint.

## Execution and limits

Options and filters are checked at creation; no database query runs until iteration starts. Each page is fully read and its native cursor is closed before the decoded batch is yielded. There is no count query, `skip` pagination, prefetch, or open server cursor while application code processes a batch. Connection readiness is checked before each page. Decode/query failures terminate iteration. No empty arrays are yielded; a short page ends the scan. An exact multiple of `size` requires a final empty query to detect exhaustion.

Chunks use ascending ObjectId order, not chronological creation order. Custom sorting, skip, total limits, and callback execution are not part of this API. Restrict the filter when a bounded range is needed.

The scan is not a database snapshot. Changes to matching rows ahead of the checkpoint can affect later pages; new or changed rows behind it are not revisited. A caller can supply an upper `_id` bound to cap a scan, but that still does not freeze document contents. Filters must preserve their intended meaning if processing updates matching fields. The helper adds no retries or checkpoint storage.

## Validation

Compile-only tests cover promised arrays, explicit cursors, typed chunk projections, excluded IDs/tokens, resume IDs, and unsupported chunk options. MongoDB tests run only in disposable `mica_chunks`, covering order/size, projection equivalence with `find`, internal ID fetching, decoder behavior, resume/filter intersections, caller mutation, early termination, exact/partial/empty pages, processing-time updates, malformed legacy IDs, and decode failures. Existing cursor tests now target `cursor`, and write regression tests remain active.
