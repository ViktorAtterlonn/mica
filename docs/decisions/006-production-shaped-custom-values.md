# ADR 006 — Validated atomic custom values

`customType()` accepts a type-guard validator and a stored JSON Schema for an atomic value whose application and stored types are identical. This supports closed unions and domain-specific values without a permissive `any` field. Scalar-base custom types and storage codecs retain their separate API.

Nullable, default, and optional modifiers compose normally. Application validation runs on inserts and supported updates; reads do not validate or reapply defaults. Applications own agreement between their predicate and stored schema.

Custom objects are atomic query/update leaves. Their internals do not acquire dotted paths, recursive codecs, or per-entry defaults. First-class maps have their own contract in [ADR 021](021-dynamic-maps.md).

Named embedded-object types and explicit registry annotations can keep TypeScript declarations manageable for large schemas while retaining inferred types. The generic custom-value, codec, and compile-only tests cover these boundaries.
