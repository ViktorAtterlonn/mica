# @mica/db

Mica's TypeScript-first MongoDB library: typed schemas and queries, plain objects, storage codecs, validators, and index declarations.

This package is unpublished and its API is still evolving. The separate `@mica/cli` package provides the `mica` executable. Installing `@mica/db` does not install the CLI or its TypeScript loader.

```ts
import { collection, createDatabase, string } from '@mica/db';

const users = collection('users', { _id: string(), email: string() });
const db = createDatabase({
  uri: process.env.MONGODB_URI!,
  database: 'example',
  collections: { users },
});

await db.connect();
try {
  await db.users.insertOne({ _id: 'alice', email: 'alice@example.com' });
} finally {
  await db.close();
}
```

`@mica/db/tooling` exposes the shared normalized schema, introspection, comparison, and explicit schema-deployment engine. Importing schemas or connecting never deploys validators or indexes.

See the [repository](https://github.com/ViktorAtterlonn/mica), [API reference](https://github.com/ViktorAtterlonn/mica/blob/main/docs/api.md), and [CLI guide](https://github.com/ViktorAtterlonn/mica/blob/main/docs/cli.md).

Apache-2.0 licensed; see LICENSE and NOTICE.
