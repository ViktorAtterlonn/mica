# @mica/cli

Explicit MongoDB validator and index tooling for `@mica/db`.

This package is unpublished. Once published, install `@mica/db` as an application dependency and `@mica/cli` as a development dependency, using compatible versions.

```ts
// mica.config.ts
import { defineConfig } from '@mica/cli';

export default defineConfig({
  schema: './src/db/schema.ts',
  database: {
    uri: process.env.MONGODB_URI!,
    name: process.env.MONGODB_DATABASE!,
  },
});
```

The schema module must default-export a nonempty collection registry. Use an ESM project.

```sh
mica check
mica diff
mica push
```

Check prints one status line and exits `0` when synchronized or `1` when drift exists. Diff shows detailed differences; both read metadata only. Push prints a plan and asks for confirmation with No selected by default. `mica push --yes` skips confirmation and progress animation for noninteractive execution. Check and diff retain `--json` support. Invalid arguments, configuration, or database operations exit `2`.

Citty defines commands and generated help (`mica --help`, `mica push --help`). Clack handles interactive output, confirmation, cancellation, and progress; `tsx` loads TypeScript config and schema files. CI and redirected output stay plain, with no spinners. No command or short option aliases are provided.

Unsupported configuration blocks push. No document migrations or collection deletion are performed. Index replacement is not transactional, and TTL indexes can cause MongoDB to expire documents.

Read the [CLI guide](https://github.com/ViktorAtterlonn/mica/blob/main/docs/cli.md), especially index ownership and deployment safety, before using push.

Apache-2.0 licensed; see LICENSE and NOTICE.
