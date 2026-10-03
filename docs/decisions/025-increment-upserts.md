# ADR 025 — Incrementing upserts

Restricted upserts now accept `$inc` alongside `$set` and top-level `$setOnInsert`. Filters remain equality-only, and Mica still validates a complete candidate insertion before sending the atomic native update.

For an incremented field, MongoDB starts from an equality-filter value when present, otherwise zero. Mica validates that resulting insertion value against the schema. A schema default on that field is not applied and its factory is not called. Untargeted fields retain their ordinary insertion defaults. For example, a counter with `.default(100)` and `$inc: { count: 1 }` inserts `count: 1` when the equality filter does not provide a count.

`$set`, `$setOnInsert`, and `$inc` cannot target overlapping paths. Initializing a nonzero counter using `$setOnInsert` on the incremented path is rejected rather than rewritten into a pipeline. Numeric object/map paths work; positional array upserts remain unsupported. Immutable/generated fields and codec-backed numbers cannot be incremented.

On an existing match MongoDB performs the increment directly, without a preliminary read. Installed validators enforce the resulting stored value. As with every restricted upsert, insertion validation can reject even when a document already exists: callers must describe a valid insertion candidate. Use a unique identity index for concurrent creation.
