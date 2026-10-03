# ADR 018 — Validated upserts and returned-write metadata

Follow-up: [ADR 025](025-increment-upserts.md) extends this contract with `$inc`. Incremented paths use native equality-seed/zero semantics instead of schema defaults.

`updateOne`, `updateMany`, `findOneAndUpdate`, and bulk update entries support `upsert: true`. The initial upsert contract supports `$set` plus top-level `$setOnInsert` and equality-only filters (literal equality or `$eq`, including bounded object paths). Other update operators on upserts remain explicitly rejected until their insertion/default behavior is defined. Ordinary updates retain the full operator set.

Mica combines equality fields, insertion-only values, and assignments into a complete candidate insertion. Required fields, defaults, generated IDs/timestamps, and codecs are validated before any command is sent, even if a document may already match. Default factories therefore execute during each upsert preflight. Encoded assignment values are reused, so insertion validation does not encode a value twice. Nested defaults are emitted without ancestor conflicts with dotted `$set` paths. Native MongoDB performs the actual match-or-insert atomically; identity uniqueness is provided by application-declared unique indexes.

`$setOnInsert` may contain immutable and generated insertion fields. `$set` retains ordinary immutable protections. On a match, insertion-only values/defaults have no effect. Generated `updatedAt` is updated unless `timestamps: false`; insertion still supplies required timestamps. Incomplete insertion candidates, overlapping explicit assignments, unsupported filters/operators, and invalid values reject before writes. Bulk preflight covers every candidate before the batch is sent.

`findOneAndUpdate(..., { includeResultMetadata: true })` returns the native metadata with a decoded, projected `value`. `lastErrorObject.updatedExisting` and `upserted` distinguish matching from creation. Without that option the existing document-or-null API remains unchanged. The default return document remains `before`, so use `returnDocument: 'after'` to read a newly inserted value. Native update results also expose typed upserted IDs.

Compile, unit, and real MongoDB tests cover creation metadata, string IDs, immutable insertion values, defaults encoded once, nested assignments, matched updates, timestamps, bulk/updateMany insertion, projected metadata, and rejection without partial writes.
