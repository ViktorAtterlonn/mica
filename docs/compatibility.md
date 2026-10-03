# Compatibility and consumer checks

Mica is pre-release. These are tested version points, not a claim that every version accepted by `engines` or dependency ranges has been verified. The package is ESM-only and uses the official MongoDB Node.js driver.

## Test matrix

| Layer                  | Pinned versions     | Coverage                                                                                |
| ---------------------- | ------------------- | --------------------------------------------------------------------------------------- |
| Node.js                | 22.13.0, 24.21.0    | Full repository check against both server versions                                      |
| MongoDB server         | 8.0.15, 8.2.2       | Disposable single-node replica sets; all integration and generated contract tests       |
| MongoDB Node.js driver | 7.7.0               | Locked repository dependency and exact isolated-consumer dependency                     |
| TypeScript             | 5.9.3, 6.0.3, 7.0.2 | Installed-package contracts, examples, and large generated consumers on Node.js 22.13.0 |
| Node type declarations | 22.20.4             | Exact isolated-consumer dependency                                                      |

CI runs the four Node/server combinations and three compiler jobs separately. It does not run a full Node/server/compiler Cartesian product. Repository implementation builds use TypeScript 7.0.2; older compilers check the emitted public declarations and consuming code. TypeScript 5.9.3 is the oldest compiler in this tested baseline; earlier compilers are unverified.

Consumer projects use `NodeNext`, ES2022, `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and **`skipLibCheck: false`**. Other module resolutions, CommonJS, bundlers, alternative runtimes, sharded clusters, and hosted database services are outside this matrix. An engine range is not evidence for untested Node major versions. Patch upgrades should update the pins and rerun these checks.

## Installed-package consumers

```sh
npm run bench:types
MICA_TYPESCRIPT=5.9.3 npm run bench:types
npm run test:compatibility
```

`bench:types` defaults to TypeScript 7.0.2. `test:compatibility` runs all three pinned compilers. Both build the library first. These commands require npm registry access and install dependencies in temporary directories; they neither publish the package nor connect to a database.

Each compiler job packs Mica, installs the actual tarball and dependencies without repository symlinks, checks an ESM runtime import, and compiles the public type fixtures and examples against the installed package. It then compiles six separate generated projects: 1 and 100 globally declared entity modules at nesting depths 3, 5, and 8. Every entity has a distinct field name and its own query module. Queries exercise typed filters, nested/array projections, hidden codec fields, stored/application types, cursors, chunks, positional updates, typed array filters, immutable fields, maps, and aggregation stages. Negative assertions must produce compiler errors.

Depth-8 schemas exercise whole-value inference below the five-level query-path budget. They do not expand the supported dot-path limit. These are synthetic cold compiler runs, not editor latency or application workload benchmarks.

The matrix exposed an excessive-instantiation error when passing a pretyped filter to a projected query. Logical filter branches now reuse their existing path entries; a small compile-only regression also runs in the normal repository check.

## Compiler budgets and reports

Each run writes `.tmp/type-bench/typescript-VERSION.json` with compiler diagnostics, elapsed time, type counts, instantiations, compiler-reported memory, and pass/failure status. The resolved consumer dependency lockfile is saved alongside it. CI uploads these reports even after a failed consumer step. Temporary installations are removed after success or failure.

Local verification measurements on 2026-10-03, Node.js 22.13.0, for the largest consumer (100 entities, depth 8):

| TypeScript | Instantiations | Compiler memory | Elapsed time |
| ---------- | -------------: | --------------: | -----------: |
| 5.9.3      |      2,307,869 |         432 MiB |       5.06 s |
| 6.0.3      |      2,311,935 |         697 MiB |       5.05 s |
| 7.0.2      |      5,132,672 |         497 MiB |       1.22 s |

Elapsed time and memory vary by machine and concurrent work. Instantiation counts are compiler-specific; compare the same pinned compiler and fixture. Memory is the compiler's diagnostic, not peak process RSS.

Checks fail above 1 million instantiations for public contracts, 800,000 for single-entity projects, 4 million for 100-entity projects on TypeScript 5/6, and 8 million on TypeScript 7. The initial single-entity counts were approximately 413,000–467,000 and contract counts 523,000–610,000. These ceilings leave room for normal fixture growth while catching substantial increases. Every compiler process also has a 120-second timeout and a 1.25 GiB reported-memory ceiling. Investigate increases before raising budgets; record a new baseline when intentionally expanding fixtures or changing compiler versions.

## Evidence limits

Local runs and hosted CI are separate evidence. See the [verification report](hardening-report.md) for completed runs. Configuring a workflow does not establish that it has passed on GitHub. These checks do not establish sustained throughput, multi-node recovery, editor responsiveness, or readiness for every application's data and rollout requirements.
