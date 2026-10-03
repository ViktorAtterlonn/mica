# ADR 029 — Separate database and CLI packages with pnpm

Status: accepted. Supersedes ADR 028's single-package entry-point locations.

## Decision

Use a private pnpm workspace root with two packages:

- `packages/db` publishes as `@mica/db`: runtime access, schemas, codecs, and the shared `@mica/db/tooling` engine. Its only production dependency is MongoDB.
- `packages/cli` publishes as `@mica/cli`: the `mica` executable, `defineConfig`, config loading, confirmation, and rendering. It owns `tsx` and declares MongoDB directly because the command runner creates a client.

The CLI consumes the database package through its public tooling export, never relative source imports. A `workspace:^` peer dependency expresses its supported database version; a workspace development dependency supplies it locally. pnpm rewrites these ranges when packing. Consumers install `@mica/db` as an application dependency and `@mica/cli` as a development dependency.

pnpm 9.12.3 is pinned in the root package manager field. Use one workspace lockfile. Recursive builds follow the package dependency graph. There is no Turborepo, release automation, or additional task runner.

Both package manifests remain private until an explicit npm release. The root always remains private. Names are selected, but npm scope access and publication have not been verified or attempted.

## Migration and verification

Move source into package-owned directories, update imports and config examples, migrate root scripts and CI to pnpm, and preserve the existing runtime/CLI behavior. Root tests retain access to package internals; examples use the public library export. Packed-package checks and compiler fixtures run outside the workspace.

The package smoke test installs a real database tarball into a temporary npm consumer and proves that `@mica/cli`, `tsx`, and `esbuild` are absent. It then installs the CLI tarball and checks the executable, configuration loading, and exported types. This intentionally uses npm to verify published-package interoperability, while repository installation and orchestration use pnpm. Compatibility and container stress consumers likewise use isolated npm installs of pnpm-produced tarballs.

Finish when frozen pnpm installation, builds, type checks, existing unit/integration tests, and both packed consumers pass. Publishing remains a separate action.
