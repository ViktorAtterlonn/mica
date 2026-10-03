# Design

Mica describes persisted data and provides typed access to MongoDB. The application owns authorization, workflows, key management, notifications, and other domain behavior.

## Schema and value boundaries

A field can have different insertion, application, and stored representations. Defaults and synchronous codecs run on supported writes. Reads decode the fields returned by MongoDB without reapplying defaults or checking required fields, so partial projections remain possible. Custom atomic values use an application predicate and a stored JSON Schema; applications own their consistency.

Fields and collections are reusable declarations. Database instances bind those schemas to a native client. Index and validator deployment is explicit through the [schema CLI](cli.md) or application deployment tooling. The shared normalized schema, metadata introspection, comparison, and push modules are exported through `@mica/db/tooling`; CLI configuration and rendering are separate consumers.

## Source layout

Runtime and shared schema-tooling modules live in `packages/db/src/`. Command-line concerns live in `packages/cli/src/`. The CLI imports the public `@mica/db/tooling` entry point. Module owners within these packages are:

| Modules                                                                                              | Responsibility                                                                          |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `fields.ts`, `schema.ts`, `indexes.ts`                                                               | Schema declarations, stored JSON Schema, and index definitions                          |
| `codec.ts`                                                                                           | Validate, encode, and decode document values                                            |
| `schema-paths.ts`                                                                                    | Resolve read/write paths and inspect codec/immutable descendants                        |
| `filter.ts`, `projection.ts`, `update.ts`, `upsert.ts`                                               | Prepare the corresponding MongoDB operation inputs                                      |
| `validation.ts`                                                                                      | Shared validation primitives and BSON type names                                        |
| `query-options.ts`                                                                                   | Normalize and snapshot driver options                                                   |
| `collection.ts`, `database.ts`                                                                       | Bind public operations to the driver and own connection lifecycle                       |
| `cursor.ts`, `chunks.ts`, `aggregation.ts`, `aggregate-filter.ts`                                    | Read traversal, pipelines, and schema-aware aggregation matching                        |
| `packages/cli/src/`                                                                                  | CLI entry point, argument parsing, config loading, confirmation, and rendering          |
| `schema-model.ts`, `schema-normalize.ts`, `schema-diff.ts`, `schema-introspect.ts`, `schema-push.ts` | Shared schema graph, normalization, comparison, metadata reads, and explicit deployment |
| `query-types.ts`, `aggregation-types.ts`                                                             | Compile-time operation and result inference                                             |

Internal modules import the owner directly. `index.ts` remains the public package boundary; moving an internal function does not add a new public API. Tests can import internal owners to verify focused runtime contracts.

## Query behavior

Operations return promises, plain documents, or explicit cursors. The toolkit validates supported input before sending a command. Bulk preflight validates every entry but does not make server execution transactional. Native error/result semantics remain visible.

Projection defaults and immutable fields are convenience and correctness boundaries within the toolkit. Raw driver operations bypass them. Application authorization must not depend on these features.

## Scope

Included: schema inference, stored representation, CRUD, typed operators, a typed read-aggregation builder, sessions, transactions, query options, metadata, and connection lifecycle.

Outside the current API: arbitrary aggregation expressions and joins, replacement writes, update pipelines, populated documents, hooks, automatic migrations, event delivery, and business lifecycle methods.

## Design decisions

The numbered [decision records](decisions/) capture API contracts and how they evolved. Later records extend earlier contracts; [the API reference](api.md) describes current behavior. [The roadmap](roadmap.md) tracks unfinished work.
