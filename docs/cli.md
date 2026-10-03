# Database schema tooling

Mica compares code declarations with MongoDB collection validators and indexes. The `mica` executable is provided by the separate `@mica/cli` package; this repository has not yet published an npm release. Install `@mica/db` as an application dependency and `@mica/cli` as a development dependency. For now, build and install local tarballs as described in the README.

For local development, build and invoke the CLI entry point directly:

```sh
pnpm run build
node packages/cli/dist/bin.js diff
```

## Configure one schema entry point

Export a collection registry from a module that only declares schemas:

```ts
// src/db/schema.ts
import { collection, index, string } from '@mica/db';

export const Users = collection('users', { _id: string(), email: string() }, (t) => [
  index('mica_users_email').on(t.email).unique(),
]);

export default { users: Users };
```

The application can pass this same registry to `createDatabase({ collections, uri, database })`. The CLI does not import a connected database instance or add a registration API.

Create **`mica.config.ts` in the directory where you run the CLI**:

```ts
import { defineConfig } from '@mica/cli';

export default defineConfig({
  schema: './src/db/schema.ts',
  database: {
    uri: process.env.MONGODB_URI!,
    name: process.env.MONGODB_DATABASE!,
  },
});
```

The schema path is relative to that directory. Its default export must be a nonempty registry with unique physical collection names. Use an ESM application (`"type": "module"` in `package.json`), consistent with Mica’s ESM package exports. TypeScript modules are loaded with `tsx`. Configuration and schema modules are trusted executable application code: keep connection calls, startup workflows, and side effects out of them. Mica declarations, `defineConfig`, and module imports never deploy validators or indexes. Environment loading is application-owned; there is no implicit `.env` loader, repository scan, alternative config file, or CLI URI override.

## Commands

```sh
mica check
mica diff
mica push
```

- `check` concisely reports managed drift. It reads metadata only and suits CI.
- `diff` explains differences deterministically, showing database/code validator values and index definitions. It reads metadata only.
- `push` displays the plan, warns about data compatibility and index risks, then asks `Apply changes? (y/N)`. Only `y` or `yes` confirms. Noninteractive use requires `--yes`.

Diff symbols: `+` needs creation, `-` needs removal, `~` needs modification, `!` requires attention. Unmanaged indexes are listed as preserved, separately from managed drift.

```sh
mica check --json
mica diff --json
mica push --yes
```

JSON uses the same versioned `SchemaDiff` as human output, including desired and actual graphs, structured changes, risks, unsupported configuration, and unmanaged indexes. BSON literals use Extended JSON; enum values and partial-filter operands are encoded literals. These outputs may include application schema/filter values, so treat saved reports accordingly.

| Exit | Meaning                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | `check`: no managed drift; `diff`: inspection succeeded, even with drift; `push`: schema matches after applying (or already matched)                    |
| `1`  | `check`: drift or unsupported configuration; `push`: unsupported configuration, declined/unavailable confirmation, or drift remaining after application |
| `2`  | Invalid arguments/configuration, schema loading failure, connection/metadata failure, or failed schema operation                                        |

Use `mica --help` for syntax. CI's minimal read-only gate is:

```sh
mica check
```

Supply the environment variables referenced by your config through your CI environment. Review `mica diff` before an explicitly authorized deployment step such as `mica push --yes`; do not make push an unreviewed production startup command. Connection selection has a five-second timeout. Index build time is left to MongoDB; failures are not hidden or retried as migrations.

## What is managed

Only collections in the registry are inspected. Missing ordinary collections are created by push with their generated validator; undeclared collections are untouched and never dropped.

Validators use the existing `jsonSchema()` stored representation, including codec storage schemas. The desired enforcement is `validationLevel: 'strict'` and `validationAction: 'error'`. Existing supported `moderate`, `off`, or `warn` settings appear as drift and are changed explicitly by push. An absent/empty validator has no effective enforcement settings.

Supported JSON Schema normalization includes BSON/type declarations, properties and pattern properties, required fields, enum, object/array bounds, string bounds and patterns, numeric bounds/multiples, additional properties/items, items, and `allOf`/`anyOf`/`oneOf`/`not`. Unknown keywords and non-`$jsonSchema` validator expressions are retained as unsupported issues. Custom stored schemas using these features therefore block deployment until supported, even if the raw definitions appear equal. Mica does not prove arbitrary logical equivalence; normalization covers known ordering/default/equality differences.

Index management covers names, **ordered** ascending/descending keys, `unique`, `sparse`, supported partial filters, and `expireAfterSeconds` (TTL). Supported partial operators match the existing DSL: equality, range comparisons, `$in`, `$exists: true`, BSON `$type` aliases, `$and`, and `$or`. Normalization preserves compound-key order, array literal order, and BSON embedded-document field order; it normalizes implicit conjunctions, equality shorthand, set-like operands, and omitted false options. Server index version/namespace and legacy `background` metadata are ignored. `hidden: false` is equivalent to absence; `hidden: true` is unsupported. The mandatory `_id` index is ignored.

### Index ownership

Declaring an index name explicitly makes it managed while present in code. For new indexes, use the reserved **`mica_` prefix**. It records durable ownership in the index's own name without a catalog collection:

- A declared index may be created or replaced to match code, after confirmation.
- A deployed `mica_` index absent from code may be removed, after confirmation.
- Any other undeclared index is preserved and does not count as managed drift.
- Unsupported options block push even on an undeclared index; they cannot be destroyed through an ownership rule.

Reserve `mica_` exclusively for Mica-owned indexes. Removing an unprefixed declaration cannot authorize its later deletion. Renaming such an index may need manual cleanup because MongoDB can reject equivalent indexes with different names. Review existing index names before adopting declarations. No automatic index-ownership metadata is written elsewhere.

## Push safety and limitations

**No document migrations:** Mica never queries, samples, infers, repairs, or transforms application documents. Validator changes use `collMod`; they do not establish that existing documents satisfy the new rules. Future writes can fail. Unique index creation can fail on duplicates; the CLI includes MongoDB's error and affected operation. Resolve data conflicts in application-owned work before retrying.

**TTL:** Deploying or changing TTL indexes can cause MongoDB's TTL monitor to delete existing documents. TTL changes carry a specific plan warning. Mica itself performs no document deletion.

**Index replacement is not atomic:** An index whose managed definition changes is dropped and recreated. If recreation fails, the original index may be absent, including its uniqueness enforcement. Index creation can take time and affect load; deletion can affect query performance. No rollback is attempted. Owned removals run before creations to support index renames.

**Partial success:** DDL operations run sequentially. Earlier operations may succeed before a later failure. Inspect a fresh diff before retrying. Push re-reads metadata after confirmation and refuses a stale snapshot; it verifies the schema after applying. This is not a lock or a transaction: coordinate schema deployments to avoid concurrent DDL.

**Unsupported features block the whole push before writes**, including with `--yes`. Examples include validator query expressions, unknown schema keywords, text/geospatial/hashed/wildcard indexes, collation, hidden indexes, unknown index options, numeric partial-filter type codes, unsupported BSON predicate values, views, capped/time-series/clustered collections, encryption options, and collection options outside validator enforcement. Purely numeric top-level index keys are conservatively unsupported because ordinary JavaScript objects cannot preserve MongoDB's key ordering for them. No force flag bypasses these checks. Unsupported source configuration is preserved in the diff.

Metadata APIs require permission to list collections and indexes; push additionally needs the relevant create/modify/drop-index permissions. Authentication errors are tool failures. Atlas Search indexes are a separate MongoDB feature/API and are not inspected or managed.

## Shared engine and future consumers

`@mica/db/tooling` exports `normalizeDeclarations`, `introspectDatabase`, `compareSchemas`, `applySchemaDiff`, and the normalized schema/diff types. It does not depend on configuration loading or CLI rendering. `applySchemaDiff` expects an unmodified plan from `compareSchemas` and checks its snapshots before writes. The tooling API is experimental alongside the rest of Mica.

The graph records existence, normalized validators and enforcement settings, ordered indexes, and unsupported issues. Changes retain before/after values, path-level validator details, and conservative risk tags. Runtime declarations and `createDatabase` are unchanged. The engine already represents validator removal, though the current DSL always generates a validator; there is no CLI switch to disable it.

Before future `pull` or Studio work, review the ownership convention, normalized format versioning, broader semantic equivalence, additional MongoDB features, concurrency coordination, and how references/custom metadata should extend the graph. No inference, migration history, rollback framework, Studio, or `pull` is implemented here. See [ADR 028](decisions/028-schema-tooling.md) for the decisions and MongoDB references.
