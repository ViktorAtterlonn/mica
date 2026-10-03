# ADR 020 — Numeric and positional array writes

Follow-up: [ADR 026](026-typed-array-filters.md) adds an optional `arrayFilter` builder with predicates inferred from the selected array field. Runtime alias/path correlation remains mandatory.

Update paths can address array entries using nonnegative numeric indexes, `$`, `$[]`, or `$[identifier]`, including nested arrays within the existing five-level path budget. Update value types follow the targeted element/property. The normal codec, validation, immutable/generated ancestor and descendant rules apply at the resolved field. Codec fields remain atomic leaves. `$unset` still requires an optional property; unsetting an array slot is not exposed as element removal.

`arrayFilters` is supported on ordinary update options and bulk update entries. Each filtered identifier must have exactly one predicate document and refer to one element schema. Missing, duplicate, unused, and cross-schema identifiers reject. Logical predicates are supported, and each field path and codec comparison is checked relative to the bound element. Filters are BSON-snapshotted. Array-filter documents currently use the native document input type; their correspondence to identifiers and element schemas is checked at runtime. Update paths and assigned values retain compile-time inference.

Potentially overlapping selector writes to the same path reject conservatively. Numeric writes to distinct indexes are allowed; wildcard/filtered selectors are treated as potentially overlapping. MongoDB determines whether `$` has a matching array element and whether an addressed array exists. Mica does not synthesize missing arrays or inspect documents first. Positional writes and array filters are excluded from the initial upsert contract.

Unit tests cover filter binding, codec restrictions, immutability, invalid selectors, and overlapping paths. MongoDB tests cover numeric, matched, all-element, and nested filtered updates, including encrypted element properties and bulk writes.
