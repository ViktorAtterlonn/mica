# ADR 028 — Explicit schema tooling and a shared comparison engine

Status: accepted for the first CLI implementation.

## Plan and reused boundaries

1. Reuse `CollectionSchema`, `jsonSchema()` and `$indexes`; leave the runtime database API unchanged.
2. Normalize declarations and MongoDB metadata into a schema graph and produce structured changes, independent of CLI text.
3. Read only declared collections with `listCollections` and `listIndexes`. Apply reviewed changes with `createCollection`, `collMod`, `createIndexes`, and `dropIndex`.
4. Load one `mica.config.ts` in the working directory and an explicit schema module exporting a default collection registry. That same registry can be passed to `createDatabase`.
5. Add thin check/diff/push commands, then normalization, comparison, CLI, package, and real-server round-trip tests.

## Ownership decision (before implementing deletion)

Managing every non-`_id` index would risk deleting another service's indexes. A separate ownership catalog would add persistent state and lifecycle concerns. Requiring a broad destructive flag on every run would still leave ambiguous ownership.

Instead, a declared index name explicitly claims that index while declared. Reserve the `mica_` prefix for durable Mica ownership: an undeclared index with this prefix can be removed after reviewing and confirming push. Other undeclared indexes are reported as unmanaged and preserved; removing an unprefixed declaration does not authorize deleting its deployed index. Use `mica_` names for new indexes whose removal should be synchronized. Renaming an unprefixed index may require manual cleanup if MongoDB rejects an equivalent second index. The mandatory `_id` index is always ignored.

Unknown index options, unsupported validators, and unsupported collection configurations are retained as structured issues. Any unsupported issue blocks the entire push before writes, including with `--yes`. There is no force/override flag.

## Normalized model

The graph stores collection existence, validators with validation level/action, ordered index keys, supported index options, and unsupported issues retaining their source configuration. Comparison returns typed collection/validator/index changes with before/after values, field-level validator differences, and risk classifications. Unmanaged indexes are separate from managed drift. Graphs and diffs are JSON-serializable; stored BSON literals use Extended JSON and preserve literal document key order.

Normalization handles schema object order, set-like schema arrays, validator defaults, index defaults, ordered compound keys, and supported partial-filter equivalences. It is not a general proof of MongoDB query or JSON Schema equivalence.

## Push contract

Push creates missing ordinary collections with the desired validator. Existing validators use `collMod`, with `strict`/`error` enforcement. This does not validate or repair all existing documents; later writes may fail. No application documents are read, sampled, or transformed. TTL indexes are supported because the DSL already supports them; MongoDB's TTL monitor can delete documents after deployment, which must appear in the plan warning.

Index replacement may require dropping before recreating and can leave an index absent if creation fails. Operations are sequential, not transactional; failure is reported with the affected operation and native error. No automatic rollback is promised. Re-read metadata after confirmation to detect a stale plan, then verify after applying. Concurrent DDL remains a race; deployment coordination is the application's responsibility.

## References

- [collMod](https://www.mongodb.com/docs/manual/reference/command/collmod/)
- [Validation of existing documents](https://www.mongodb.com/docs/manual/core/schema-validation/specify-validation-level/)
- [Index metadata](https://www.mongodb.com/docs/manual/reference/method/db.collection.getindexes/)
- [Partial indexes](https://www.mongodb.com/docs/v8.0/core/index-partial/)
