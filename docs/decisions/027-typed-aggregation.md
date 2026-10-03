# ADR 027 — Typed read aggregation

Collection `aggregate(options?)` returns an immutable builder with an evolving schema. `match`, `project`, `group`, `sort`, `skip`, `limit`, and `count` append read stages; `toArray()` executes and returns inferred plain objects. Execution is explicit, and every call executes a new command. Builder branches share no caller-mutable stage documents.

Projection carries surviving field definitions forward, including nested structure and codecs. Group/count replace the schema. Subsequent predicates, references, and result types use that current schema. Callers cannot insert raw stages or supply an arbitrary result type that bypasses inference.

MongoDB operates on stored values. Grouping initially accepts a scalar field reference or null key, numeric `$sum`/`$avg`/`$min`/`$max`, and finite numeric constants for `$sum`. Codec-backed fields cannot be compared, sorted, or accumulated. Their unchanged projected values can still be decoded on return. Missing/nullable group keys and nullable aggregate results remain represented in types.

Match inputs accept ObjectIds or 24-character hexadecimal strings on ObjectId fields. Conversion follows the evolving stage schema, never a guess based on value contents or the original collection's `_id`. It covers comparison operands, membership, nested literals, and nested/logical predicates; structural operands are preserved. Invalid ObjectId strings fail before execution. This is an aggregation-input convenience only: ordinary queries/writes, raw operations, codec rules, and returned ObjectId types retain their contracts.

All surviving fields are returned unless explicitly projected away. Codecs run only for returned fields. Group outputs do not inherit an unrelated source field’s codec, even when they share its name.

The builder validates stages and execution options before querying. It retains native session, deadline, cancellation, and error behavior and closes its internal cursor after execution. Unlike find's unlimited zero limit, the aggregation limit must be positive. Count on empty input produces no document.

Whole-map projections are supported; individual map-entry projections, compound keys, array/map group traversal, arbitrary expressions, unwinding, joins, facets, aggregation streaming, and write stages are deferred. Unsupported pipelines remain separate native driver operations with caller-owned storage semantics. Update pipelines are a separate write feature and remain deferred.

Evidence: compile-only stage/result fixtures, unit checks of branch isolation and preflight/cleanup, MongoDB integration for grouping, projections, codecs, selection, sessions, and exported package type checks.
