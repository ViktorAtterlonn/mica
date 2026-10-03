# ADR 001 — Independent application, insert, and stored representations

Status: accepted for Phase 0. Date: 2026-10-01.

## Question and experiment

Can an application-supplied `encrypted().max(500).optional()` preserve string modifiers while inferring Binary storage? Can defaults inside objects and array elements remain optional on inserts but required on selects?

`tests/types.ts`, `tests/codec.test.ts`, and `examples/entities/products.ts` exercise all three together. String → BSON Binary codecs, optional ciphertext, embedded defaults, nullable fields, and arrays compile with the intended types and round-trip through real MongoDB.

## Decision

An immutable Field descriptor carries phantom application, storage, insert, kind, optional/default/generated, child, and element parameters. Capability-limited methods return a fresh descriptor. TypeScript rejects irrelevant modifiers through their `this` constraints. A descriptor class is schema configuration only; database results are ordinary objects with no wrapper classes.

`customType()` accepts a base factory, semantic metadata, and optionally a scalar codec plus stored JSON Schema. It reuses the same Field builder with a different stored parameter; it does not intersect an old builder with new codec methods. Constraints belong to the application value. Metadata can be discovered through nested objects/arrays (`variants[].title`). Reference thunks remain lazy metadata.

`$inferSelect`, `$inferInsert`, and `$inferStored` are independent mapped types. Inferred data is mutable. The markers have no runtime value. Runtime schema inspection uses `$fields` and `$name`, avoiding collisions with ordinary fields such as `name`.

## Consequences and limits

Synchronous scalar codecs prove the architecture without a plugin class hierarchy. Null bypasses a codec; optional omission also bypasses it. Composite or stacked codecs are explicitly rejected in the prototype. Custom constraints beyond the base vocabulary, asynchronous codecs, codec contexts, key rotation, and decode migrations remain open. The AES-GCM example is application code, not core cryptography or a key-management design.

No change to the requested schema-authoring API was necessary. Index declarations are deferred to Phase 1, rather than replaced with another syntax.

Validated atomic custom values extend the schema vocabulary; see [ADR 006](006-production-shaped-custom-values.md).
