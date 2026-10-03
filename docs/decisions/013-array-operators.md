# ADR 013 — Scalar array set operations

Follow-up: [ADR 024](024-object-pull.md) adds embedded-object `$pull` predicates while retaining the scalar-only `$addToSet` contract.

`$addToSet` and `$pull` use the shared update encoder across individual, multi-document, returned-document, and bulk updates. `$addToSet` accepts one scalar element or `$each`; `$pull` accepts a scalar or a supported scalar filter predicate. MongoDB performs membership and removal atomically per document. Mica does not fetch, edit, or replace the array in application memory.

Initial support covers scalar arrays without codecs. Codec equality is not assumed to preserve application equality. Embedded object predicates and nested array values need a separate contract. Addition validates element values; removal validates predicate syntax without applying insertion defaults. Array length constraints require an installed server validator because the client does not know the resulting length.

Immutable arrays reject both operators. Immutable elements may be added as new insertions, but removing protected descendants rejects, consistent with whole-container removal. Path conflicts, generated timestamps, and whole-bulk preflight retain their existing behavior.

Compile tests cover eligible paths and values. Unit tests exercise codecs, immutability, syntax, and conflict failures. Disposable MongoDB tests verify deduplication, regex/range removals, and all update entry points.

## Numeric and date comparison updates

`$min` and `$max` accept non-null, non-codec number/date candidates. They use the ordinary field validation (including numeric bounds and integers), then MongoDB compares the candidate with the stored value atomically. Missing fields are initialized with the candidate, without defaults. Immutable fields and ancestors remain protected. Null candidates, string comparisons, and codec-backed comparisons are outside this contract. Concurrent numeric/date comparisons are verified against disposable MongoDB.

## Push modifiers and timestamp control

`$push` supports `$each` with optional `$position`, `$slice`, and `$sort`. Position and slice are safe integers, including negative values. Sort accepts `1`/`-1` for codec-free scalar elements or an element-relative sort document for embedded objects. Codec-backed sort paths reject. Trimming arrays containing immutable/generated descendants rejects; new elements may still be appended. MongoDB applies its native insertion/sort/slice order. Result length constraints require a server validator.

Updates accept `{ timestamps: false }` in `updateOne`, `updateMany`, and `findOneAndUpdate`, and individually on bulk update entries. This skips only the automatic top-level `updatedAt` assignment. The default is true. Generated fields remain protected from direct changes. Insertions retain required generated creation/update timestamps; this option controls updates, not the insert schema.
