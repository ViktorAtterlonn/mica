# ADR 003 — Encode every supported write; reject unproven routes

Status: accepted for Phase 0. Date: 2026-10-01.

## Experiment

The representative entity has codecs at the root, inside an embedded object, inside an array of objects, and directly on array elements. Tests inspect raw BSON after insertion, nested `$set`, whole-object replacement, `$push`, and `$each`. Every supported encrypted value is Binary; decoded results are plain objects. Unsupported operations are rejected before an update command is sent.

## Decision matrix

| Operation or shape                            | Decision and reason                                                                                                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `insertOne`                                   | Walk schema once to validate, materialize defaults/generated values, and encode recursively. Build a fresh document; caller input is not mutated.                           |
| `$set` scalar/dotted embedded field           | Resolve a schema path and encode the application value at that boundary.                                                                                                    |
| `$set` whole embedded object/array            | Recursively encode the full replacement value, applying nested insert defaults. Required fields cannot be omitted unless defaulted/generated.                               |
| `$push` direct item / `$each`                 | Encode every appended element, including nested fields/defaults. Only `$each` is supported as a push modifier.                                                              |
| Numeric/positional array paths                | Reject for now; resolving `$`, `$[]`, and `$[identifier]` consistently with array filters is a separate experiment.                                                         |
| Projections                                   | Only visit returned properties. Do not fill missing defaults or validate required fields on reads. Whole-field projections cannot split a scalar ciphertext.                |
| Upsert / `$setOnInsert`                       | Reject. A codec-aware upsert must reconcile query-seeded fields, required values, defaults, timestamps, and operator path conflicts. Encoding `$set` alone is insufficient. |
| Replacement writes                            | No wrapped `replaceOne`. Root replacement inside `updateOne` is rejected. Future support needs explicit immutable-id/createdAt and replacement-default semantics.           |
| Bulk operations                               | No wrapped `bulkWrite`. Future implementation should preflight each operation with the same codecs before sending a batch and preserve driver partial-failure behavior.     |
| Pipelines, `$rename`, `$inc`, other operators | Reject. Moving raw ciphertext or constructing values server-side cannot be assumed safe. Numeric operators may be added only with field capability checks.                  |
| Filters                                       | Native application filters on ordinary fields; only `$exists` on codec fields or codec-bearing parents. Randomized encryption cannot support naive equality/ranges.         |
| Raw driver                                    | Only through `db.client`; caller owns stored values and all persistence semantics.                                                                                          |

Callbacks may throw; codec failures propagate before writes. Promise/undefined codec results are rejected. The application is responsible for returning the declared stored type. Generated server validators catch storage-type violations when explicitly installed.

## Consequences

Supported writes cannot silently pass plaintext through an unhandled path. MongoDB executes queries, update operations, conflict detection, and result reporting; the toolkit does not emulate database behavior. There is no translation execution, populate, hydration, or general hook mechanism.

Validating appended items cannot enforce constraints on the final array length without reading the document; use the MongoDB validator for final-document constraints. The spike does not add hidden read-before-write queries. Input and update objects are preserved, but application-owned codec functions must themselves avoid mutating values.

Next experiments: equality-capable codec metadata, asynchronous codecs, bulk preflight/failure semantics, and operator coverage selected from real pilot usage.
