# ADR 007 — Typed index declarations with explicit deployment

Status: accepted.

Schemas declare ordered compound keys, nested multikey paths, unique and sparse indexes, and partial filters using `collection(name, fields, t => [index(name).on(...)])`.

## Declaration and storage boundary

Callback references carry collection ownership and a stored-value partial-filter type. Bare references mean ascending; `.asc()` and `.desc()` preserve explicit direction. Nested references use typed MongoDB dotted paths, including paths through embedded arrays. This avoids collisions between embedded field names and reference methods. Index traversal uses the query type system's five-level budget, counting array descent; custom atomic values have no child paths.

`.unique()`, `.sparse()`, and `.partial(filter)` produce new immutable declarations. Partial filters describe stored BSON values, not application input. They support equality/range, `$in`, `$exists: true`, `$type` alias, and logical `$and`/`$or` predicates. Index declaration never executes a storage codec. Runtime validation checks ownership, names, duplicate keys, paths, supported predicate syntax, and incompatible sparse/partial options. MongoDB determines whether an index is legal for the actual data and server configuration. Its [partial-index restrictions](https://www.mongodb.com/docs/manual/core/index-partial/) remain applicable.

The schema's `$indexes` getter returns fresh `IndexDescription[]` values, ready for native `createIndexes()` through `db.client`. Partial filters are snapshotted with BSON serialization so mutations to source or exported objects do not change the declaration. BSON ObjectIds, dates, and Binary values survive the snapshot. Key order is retained; integer-looking key names use a native Map when an object would reorder them.

Index installation is explicit. There are no connection-time writes, index diffing, drops, rebuilds, collection hooks, or application lifecycle features. The existing two-argument `collection()` API still works and exposes an empty index list.

## Type-system evidence

Eager generic path expansion hit TS2589 on larger schemas. Deferred conditional aliases resolve the schema before expanding index references and partial filters. An erased internal callback boundary connects those public types to a checked runtime walker, following the existing query implementation pattern. Entity fields stay inline, retain their inferred data types, and require no casts or wrapper functions.

Compile-time tests reject unknown paths, raw field strings/builders, missing index keys, enum mismatches, plaintext predicates for Binary codecs, unsupported predicates, and paths beyond the traversal budget. Runtime tests cover declaration isolation, foreign references, BSON snapshotting, generated names/options, key order, and invalid syntax. MongoDB integration tests exercise explicitly deployed validators, indexes, and TTL expiration.

## Remaining scope

The public declaration surface covers ascending/descending indexes with unique, sparse, and partial modifiers. TTL declarations are added in [ADR 012](012-distinct-and-ttl.md). Hashed, text, geospatial, wildcard, collation, and other options remain deferred. Single-field `_id` indexes remain MongoDB-owned. Partial predicate runtime checking validates syntax and paths, not full operand/schema compatibility after TypeScript is bypassed. Filter literals currently cover plain BSON documents/arrays, strings, finite numbers, booleans, null, dates, ObjectIds, and Binary values; other BSON wrappers, regex predicates, and numeric `$type` codes remain unsupported.
