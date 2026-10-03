# API contract audit

Date: 2026-10-03. Scope: the exported API and its existing runtime/type checks, followed by generated correctness tests of common persistence combinations. This establishes a candidate contract for further hardening; it is not a stable release or a claim of exhaustive verification.

## Contract and evidence inventory

| Surface                                                | Contract retained                                                                                                                                                       | Evidence                                                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Field builders, objects, arrays, maps, custom values   | Required/optional/null/default distinctions; explicit ObjectId generation; no implicit embedded IDs; atomic map entries and custom values                               | `codec.test.ts`, `maps.test.ts`, `custom-values.test.ts`, generated schema matrix                        |
| Codecs and metadata                                    | Application values on writes, stored representations in BSON, selected values decoded on reads; synchronous application-owned codecs; metadata has no lifecycle effects | Codec tests, raw BSON comparisons, generated codec cases, metadata examples                              |
| Constraints and `jsonSchema`                           | Validate supplied write values; deploy validators explicitly for final-document constraints; server validators describe stored values                                   | Codec/operator integration suites; generated validator installation; schema-boundary regressions         |
| Index declarations                                     | Explicit installation; typed owned field references; supported partial predicates; TTL constraints; no automatic schema deployment                                      | Index unit/integration tests and TTL tests; sparse partial-predicate regression                          |
| `find`, `findOne`, projections                         | Plain decoded objects, literal projection inference, explicit inclusion and exclusion                                                                                   | Field-option and capability tests; compile fixtures; generated comparisons with independent native reads |
| `cursor`, `chunks`                                     | Decoding across consumption paths; cleanup; explicit pagination semantics and internal `_id` checkpoints                                                                | Cursor/chunk suites; generated projections with excluded IDs across multiple pages                       |
| Filter vocabulary                                      | Typed paths/operands; runtime syntax and codec restrictions; filter serialization must not silently drop undefined values                                               | Filter/operator tests; invalid-input preflight across read/write entry points                            |
| Insert, update, delete, returned-document writes, bulk | Shared write validation and codec handling; immutable/generated protections; native result/error semantics; batch preflight is not a transaction                        | Query, operator, hardening and feature suites; generated stored-BSON and returned-document comparisons   |
| Upserts and array filters                              | Restricted validated insertion candidate; explicit typed positional paths; identifier binding and protected-descendant checks                                           | Upsert, capability, array-filter and hardening suites                                                    |
| `distinct`, `exists`, counts                           | Native result semantics within supported paths; codec restrictions; count/existence do not decode unrelated values                                                      | Query/distinct tests and type fixtures                                                                   |
| Aggregation                                            | Current-stage typing through the supported stages; selected codecs decode after execution; ObjectId string matching follows the current schema                          | Aggregation unit/integration/type suites; generated numeric groups, projections and ObjectId matches     |
| Connections, sessions, transactions, execution options | Explicit connection; native sessions and retry behavior; structured Mica errors, preserved driver/codec errors; deadlines and cancellation                              | Lifecycle, transaction, workflow and failpoint tests; actual multi-node failure coverage remains pending |
| Package exports and inference                          | Public imports and exported declarations work in a packed consumer                                                                                                      | Package smoke test and compile-only fixtures; broader compiler/runtime matrix remains pending            |

Tests above are in [tests](../tests/); current details and limitations are in the [API reference](api.md). Historical decision records describe earlier stages of the API and do not supersede the current reference.

## Mismatches fixed in this audit

1. **Undefined filters could change meaning during BSON serialization.** Undefined object members disappeared; undefined or missing array elements could become null. Filters now reject these values before serialization, including logical/nested predicates, array filters, scalar removal predicates, and aggregation matches. Explicit null remains meaningful. Cyclic plain filter values also reject.
2. **Sparse write arrays skipped element validation.** Encoding used array mapping, which skips holes. Inserted arrays and `$each` operands now visit every index and reject missing elements. Partial-index operand arrays also reject holes instead of serializing a different predicate.
3. **String/array length bounds could produce unusable validators.** Negative, fractional, or unsafe length bounds now fail at schema construction. Numeric bounds still allow finite negative/fractional values.
4. **Schema field names could contain a null byte.** These now fail at declaration time rather than reaching BSON serialization.

The regression suite verifies preflight with a command listener: invalid filters across collection methods and sparse inserts/updates issue no read/write command and leave the synthetic data unchanged. Tests run without a validator for this check, so server validation cannot conceal a missing client check.

## Generated correctness methodology

The default matrix contains **64 cases**: eight leaf kinds × four layouts × two modifier variants. Kinds are text, number, boolean, date, ObjectId, binary, enum, and a string-to-Binary codec. Layouts are scalar, embedded object, array of embedded objects, and dynamic map. Variants include defaults, optional/nullable values, null array elements, empty containers, and explicit ID/nested projections.

Every case constructs five synthetic documents and three separate collections:

- Mica writes to the actual collection, with its generated MongoDB validator installed.
- Native-driver writes create independently specified stored BSON in a reference collection.
- Native-driver writes create application-form values in another reference collection for projection comparisons.

The oracle does not import Mica's internal encoder, decoder, projection builder, or schema walkers. It uses a deliberately small fixture encoding with independently constructed expected bytes. This tests codec traversal and storage boundaries, not cryptographic strength.

Each run covers 480 projection configurations across `find`, `findOne`, cursor consumption, chunks, and aggregation; six seeded updates per case; a nested/positional returned-document update; a bulk update/delete; grouping; and ObjectId matching. Raw stored documents are compared after writes. MongoDB performs the reference projections and operations, so the test does not reimplement MongoDB semantics in JavaScript.

The generator uses a fixed uint32 seed by default and mixes in the case number. Replaying one case produces the same inputs without running earlier cases. Failures name their seed and case; focused and replay commands are in [CONTRIBUTING](../CONTRIBUTING.md#generated-contract-tests).

Generated schemas/projections use intentionally broad runtime test types. They do not prove TypeScript inference. The separate literal compile-only fixtures and packed-consumer checks test inference and rejected programs.

## Remaining release gates

- Expand generated combinations to timestamps, upserts, partial-index semantics, and transaction schedules; their existing fixed tests remain the current evidence.
- Run a declared Node.js/TypeScript/driver/server compatibility matrix in hosted CI. Version points and completed local runs are tracked in the [compatibility matrix](compatibility.md) and verification report.
- Expand beyond the installed-package compiler benchmarks to editor responsiveness and sustained runtime workloads, including memory and connection cleanup.
- Extend the local three-member election/crash/uncertain-commit and pool-exhaustion checks to asymmetric network partitions, independent hosts, and prolonged outages.
- Complete a focused review of validation/codec boundaries and finish version/release/upgrade policy.

Keep each newly supported operation tied to an API contract, compile-time tests where applicable, and runtime evidence. Do not add type assertions to the implementation merely to make a contract test pass.
