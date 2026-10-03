# Changelog

## Unreleased

Removed the schema-level `select()` modifier and implicit field exclusions. Reads now return all fields by default; use explicit query projections to shape results and exclude codec values before decoding. `$inferSelect` describes the full application shape.

Initial public repository preparation. The current library includes typed schemas and queries, codecs, explicit indexes and validators, CRUD and bulk operations, projected cursors/chunks, positional updates, restricted upserts, transactions, deadlines, and structured validation errors.

No stable release or compatibility guarantee has been declared.

Added an immutable typed aggregation builder with inferred results through `match`, `project`, `group`, `sort`, `skip`, `limit`, and `count`. Numeric accumulators, projection-aware codecs, execution options, and explicit sessions are supported.

Aggregation matches accept ObjectId strings and convert them using the current stage's schema, including nested predicates and matches after grouping. Malformed ObjectId strings fail before querying; string fields and output types remain unchanged.

Added a seeded 64-case schema/operation matrix against independent native-driver collections and documented an API contract audit. Undefined filter values, sparse write/index-predicate arrays, invalid string/array length bounds, and null-byte schema field names now reject before serialization or execution.

Added a pinned Node.js/MongoDB CI matrix and installed-package consumer checks for TypeScript 5.9.3, 6.0.3, and 7.0.2, including 100-entity projects, diagnostic reports, and compiler budgets. Recursive logical filters now reuse path entries, fixing excessive type instantiation when a pretyped filter is passed to a projected query.

Added opt-in local load and three-member recovery suites with latency/memory reports, exact write accounting, cursor/pool cleanup checks, primary crashes, transaction elections, uncertain commits, queue exhaustion, and majority loss. After an initial successful connection, operations now defer temporary topology loss to the driver so native deadlines and transaction retries remain effective; pre-connect and closed-instance guards remain enforced.
