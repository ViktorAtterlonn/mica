# ADR 008 — Default selection and immutable fields

## Decision

Fields support `.select(false)` and `.immutable()` independently of encryption. Both modifiers preserve their flags through other modifiers and custom-type bases, without mutating reusable builders.

`.select(false)` excludes a field from ordinary reads. The read boundary builds a MongoDB projection before fetching data: hidden ciphertext is not fetched or decoded. Defaults traverse objects and arrays, including nested arrays. Mark an array container or its object properties as hidden; marking an array element itself hidden is rejected.

Projection inputs remain literal top-level 0/1 maps. Missing, empty, and exclusion projections preserve schema exclusions. An inclusion projection explicitly selects complete named fields, including any hidden descendants of a selected object/array. For example, `{ profile: 1 }` opts into the whole profile, while `{ name: 1 }` does not expose hidden fields elsewhere. Dotted opt-in projections are added in [ADR 019](019-nested-projections.md). Mixed modes remain invalid except for MongoDB's `_id` exception. A hidden `_id` stays excluded unless explicitly included.

`$inferSelect` now describes the default read shape, recursively omitting hidden properties. Insert and storage shapes remain complete. `SelectResult<Fields, Projection>` describes explicit projected reads; the existing shape-only `Project<T, P>` helper remains available. Selection flags must be boolean literals so inference cannot promise a field that a runtime flag might hide. `.select(true)` restores selection on a derived builder.

`.immutable()` permits insertion (including defaults) and rejects subsequent direct updates or writes through immutable ancestors. Whole-object and whole-array `$set` replacements containing immutable or generated descendants are also rejected, even if the supplied value claims to be identical. This avoids a preliminary read, comparison races, or silent stripping. Update types exclude those paths; runtime checks protect JavaScript and cast callers. Returned plain objects remain locally mutable.

An array containing immutable children can receive new elements via `$push`/`$each`; those elements are new insertions. Mark the array itself immutable to prevent appends. `_id` and generated fields retain their existing protection. Descendant protection checks are not truncated at the five-level dot-path typing limit.

These are toolkit read/write rules, not database authorization. Raw driver access bypasses both. Generated MongoDB validators remain structural; they do not compare old/new values or implement selection. Future query methods must use the same projection and write checks.

## Validation

Unit and compile-only tests cover modifier composition, nested visibility, explicit projections, hidden `_id`, immutable ancestors, parent replacements, array appends, schemas with no writable paths, and protection below the dot-path limit. Real MongoDB tests inspect issued projections and codec calls, verify stored updates, and confirm that rejected immutable writes send no update command.

## Query API follow-up

At the time of this decision the typed collection exposed `findOne`, `insertOne`, and `updateOne`. The following operations, plus `exists`, are now implemented in [ADR 009](009-query-and-batch-operations.md):

1. `find` with typed projections, sorting, pagination, and a decoding cursor (`toArray`, async iteration, explicit close).
2. `countDocuments`, `deleteOne`, `deleteMany`, `insertMany`, and `updateMany` with consistent preflight validation and native result shapes.
3. `findOneAndUpdate` and `findOneAndDelete` with explicit returned-document and projection semantics.
4. `bulkWrite`, validating and encoding every supported operation before sending a batch, with defined ordered/unordered error behavior.

`$unset` and `$inc` are now implemented in [ADR 011](011-unset-and-increment.md), including protection against removing immutable descendants. `$addToSet`, `$pull`, positional paths, and array filters still need explicit codec and immutability contracts. Upserts, replacements, sessions/transactions, and aggregation also remain deferred.
