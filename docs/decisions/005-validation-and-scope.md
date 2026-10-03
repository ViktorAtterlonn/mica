# ADR 005 — Stored JSON Schema and an intentionally small spike surface

Status: accepted for Phase 0. Date: 2026-10-01.

## Experiment and decision

Generated validators cover the implemented BSON primitives, enums, required fields, nullable values, objects/arrays, numeric ranges, integer multiples, lengths, and flagless patterns. Codec fields substitute their supplied stored schema; application string limits do not leak onto Binary storage. Server integration accepts the generated product validator and rejects direct plaintext writes into an encrypted field and an empty title.

Objects declare `additionalProperties: false`. Collections explicitly declare a required non-null ObjectId `_id`, generally with `.auto()`. Embedded documents gain no `_id` automatically. Validators are generated without issuing commands. Applying them is explicit through the native client in examples/tests; schema diffing and migration remain future work.

Writes check application types/constraints while traversing the schema for encoding. Reads perform only structural codec traversal, without full validation/default generation. This keeps a single persistence walk and avoids hydration. It still allocates ordinary result objects, so throughput/allocation claims require benchmarking.

Defaults and generated values are fill-if-missing on insert. Optional means absent, nullable means null, and explicit undefined is rejected. Top-level timestamps use the application clock; createdAt is preserved on update and updatedAt advances. Only root timestamp management is in scope. References are lazy metadata only.

## Deferred scope

No index implementation, `find` cursor/list API, deletion, aggregation wrapper, bulk wrapper, replacement wrapper, sessions/transactions, migration tooling, adapters, Studio, population, or general hooks. Core primitives are present because they share the same small descriptor; no production-complete modifier/operator vocabulary is claimed.

Before a production pilot, validate every required operator and deployment topology, specify timestamp behavior for embedded documents/upserts/replacements, decide runtime validation policy and errors, and compare against real entities. Phase 0 did not change the requested public API to work around an impossibility. The unsupported cases are deliberate scope boundaries, not claims that those APIs cannot be implemented.
