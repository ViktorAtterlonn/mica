# Contributing to Mica

Use an issue to discuss a substantial API change before implementing it. Small bug fixes and documentation corrections can go straight to a pull request. Include a minimal reproduction for bugs, with synthetic data and no credentials.

## Local setup

Use Node.js 22.13 or newer, the pnpm version pinned in `package.json` (via Corepack), and a running Docker daemon. `.nvmrc` pins the baseline development version.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run check
```

## Repository layout

| Directory           | Purpose                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `packages/db/src/`  | Library implementation, shared schema tooling, and public types       |
| `packages/cli/src/` | CLI commands, config loading, confirmation, and rendering             |
| `tests/`            | Unit tests, compile-only fixtures, and MongoDB integration tests      |
| `examples/`         | Generic entity modules, codecs, and application workflows             |
| `docs/`             | API contracts and design decisions                                    |
| `scripts/`          | Disposable database runner, type benchmarks, and package verification |

## Focused checks

```sh
pnpm run lint
pnpm run format
pnpm run typecheck
pnpm test
pnpm run test:integration
pnpm run test:generated
pnpm run test:package
pnpm run bench:types
pnpm run test:compatibility
```

`tests/types.ts` checks both inferred types and intentional compilation failures. Runtime type casts are not a substitute for validating JavaScript callers. Changes to persistence behavior should include meaningful real MongoDB coverage; changes to inference should include compile-only coverage.

Integration tests create a uniquely named single-node replica set bound to loopback, enable test-only failpoints, and remove the container and its volumes afterward. The default image is pinned in `scripts/integration.mjs`; `MICA_MONGO_IMAGE` can override it for compatibility testing. Docker failures are reported rather than skipped. The package smoke test packs both workspaces and installs them into a temporary npm consumer. It verifies that the database package works without CLI dependencies, then checks the CLI executable and declarations. No packages are published. Repository commands use pnpm; isolated npm consumers verify interoperability.

The [compatibility matrix](docs/compatibility.md) covers pinned Node/server combinations and three TypeScript versions. `bench:types` installs a packed consumer using registry dependencies and checks compiler budgets; `test:compatibility` repeats it for all three compilers. These are separate CI jobs from `pnpm run check`. The GitHub workflow currently runs only when manually dispatched; automatic CI is deferred. Reports are saved under `.tmp/type-bench/`.

## Generated contract tests

The normal integration suite includes the deterministic generated matrix. Run it alone, vary its data seed, or replay a failing case:

```sh
pnpm run test:generated
MICA_GENERATED_SEED=1 pnpm run test:generated
MICA_GENERATED_SEED=1372200998 MICA_GENERATED_CASE=17 pnpm run test:generated
```

Seeds are uint32 integers; case numbers are 0–63. Use the seed and case printed by the failing test. The runner always creates a fresh disposable MongoDB container. Expected BSON and projected results come from separate native-driver reference collections, without invoking Mica's internal transformations. See the [contract audit](docs/api-contract-audit.md) for covered combinations and limits.

When fixing a generated failure, retain a small named regression for its underlying rule. Keep the reference implementation independent; changing both the library and the oracle to agree is not evidence of correctness.

## Local load and recovery checks

`pnpm run test:load` measures bounded read/write/mixed workloads and large-document memory. `pnpm run test:recovery` runs a disposable three-member replica set through crashes, elections, uncertain commits, and pool/majority loss. Both are opt-in local commands with reports under `.tmp/stress/`; see [stress testing](docs/stress-testing.md) for settings, assertions, and limitations.

## Pull requests

Explain the problem, the resulting behavior, and how you tested it. Keep changes focused and update the API reference or a design decision when changing a contract. Run `pnpm run check` before requesting review. Avoid generated output, local logs, private application schemas, real customer data, and secret configuration in a contribution.

Schemas remain globally declared modules. Prefer explicit database operations and application services over model hooks. Preserve native driver error semantics and keep the application/stored-value boundary explicit.

## Code style and module boundaries

Prefer guard clauses and early returns for invalid inputs, absent values, and completed cases. In loops, use `continue` to skip a completed case rather than nesting the next operation in an `else`. Keep ordinary loops when they express traversal clearly or avoid intermediate arrays; readability does not require replacing every loop with chained callbacks.

Keep value codecs, query filters, projections, update encoding, and schema-path traversal in their owning modules. Put shared runtime validation primitives in `validation.ts`; avoid generic utility layers or parallel implementations of the same rule. Use small named helpers for a distinct responsibility, not merely to hide a few lines. Preserve validation order, error identity, caller-input snapshots, and codec invocation counts when refactoring.

Recursive TypeScript inference deserves the same care as runtime code. Do not rewrite conditional types for cosmetic consistency with runtime code; check inferred contracts and compiler budgets when changing them. Performance claims need measurements, and caching requires a demonstrated safe ownership boundary.

## Licensing

Submit only work you have the right to contribute. Contributions to this project are provided under the project's Apache-2.0 license unless explicitly agreed otherwise.
