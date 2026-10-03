# Mica

A TypeScript-first MongoDB toolkit with Drizzle-inspired schema syntax, type-safe queries and projections, and reusable custom fields with codecs and metadata.

Mica runs on the official MongoDB driver and returns plain objects. Database operations stay explicit: `find()` returns an array, `cursor()` streams results, and `chunks()` reads batches using `_id` checkpoints.

**Status: early development.** The API may change. This repository is usable locally; an npm release has not been published from this project. Start with a controlled application trial before a production rollout.

[API reference](docs/api.md) · [Examples](examples/README.md) · [FAQ](docs/faq.md) · [Design](docs/design.md) · [Compatibility](docs/compatibility.md) · [Contributing](CONTRIBUTING.md)

## Why Mica?

Mica carries your schema's types through the data you insert, the queries you write, and the results you read.

- **Type safety across supported operations.** Infer insert, selected, and stored types from one schema. Check field paths, filter values, and updates against that same declaration.
- **Projections that shape the result type.** Select only `title`, and TypeScript knows the result contains only `title`. Nested object and array projections participate in inference too.
- **Custom fields with codecs and metadata.** Define reusable fields that convert between application and stored values, attach meaning such as `encrypted` or `translatable`, or do both.
- **Drizzle-inspired syntax.** Compose entities from field builders such as `string().optional()` and `enum_('open', 'done').default('open')`, then export them from ordinary modules.

Persistence lives in collection operations; application behavior lives in ordinary functions. There are no document instances to track or save, and importing a schema does not change your database.

For a comparison with Mongoose, guidance on choosing the native driver, and migration considerations, see the [FAQ](docs/faq.md).

## Define your entities

Entities live in ordinary modules and can be shared across your application.

```ts
// entities/tasks.ts
import { collection, enum_, objectId, string, timestamps } from 'mica-mongodb';

export const Tasks = collection('tasks', {
  _id: objectId().auto(),
  title: string().min(1),
  state: enum_('open', 'done').default('open'),
  ...timestamps(),
});

export type Task = typeof Tasks.$inferSelect;
export type NewTask = typeof Tasks.$inferInsert;
```

## Use the database

```ts
import { createDatabase } from 'mica-mongodb';
import { Tasks } from './entities/tasks.js';

const db = createDatabase({
  uri: process.env.MONGODB_URI!,
  database: 'example',
  collections: { tasks: Tasks },
});

await db.connect();

try {
  const { insertedId } = await db.tasks.insertOne({ title: 'Try Mica' });

  await db.tasks.updateOne({ _id: insertedId }, { $set: { state: 'done' } });

  const tasks = await db.tasks.find(
    { state: 'done' },
    { projection: { title: 1, _id: 0 }, timeoutMS: 2000 },
  );
  // Inferred as { title: string }[]

  for (const task of tasks) {
    console.log(task.title);
    // task.state would be a TypeScript error: it wasn't selected.
  }
} finally {
  await db.close();
}
```

The package name above is the local package identity, not a claim that it is available on npm. For use in another project, build a local tarball with `npm pack` and install that tarball.

## Define your own fields

Custom fields keep their base type and modifiers while adding application-specific meaning:

```ts
import { collection, customType, discoverMetadata, objectId, string } from 'mica-mongodb';

const translatable = customType({
  base: string,
  metadata: { translatable: true },
});

const Articles = collection('articles', {
  _id: objectId().auto(),
  title: translatable().min(1),
  summary: translatable().optional(),
});

discoverMetadata(Articles, 'translatable');
// [{ path: 'title', value: true }, { path: 'summary', value: true }]
```

Add a codec's `encode`, `decode`, and `storedSchema` to give a custom field a different storage representation. For example, an encrypted field can be a `string` in application code and BSON `Binary` in storage, with both types inferred. Metadata describes the field; codecs convert its value. See [custom types](docs/api.md#custom-types) and the [encrypted field example](examples/fields/encrypted.ts).

## What is included

- Inferred insert, selected, stored, filter, update, and projection types.
- Embedded objects, arrays, dynamic maps, custom values, defaults, and constraints.
- Explicit query projections and immutable fields.
- CRUD, bulk writes, distinct values, cursors, and projected chunks.
- A typed aggregation builder with inferred results through filtering, projection, grouping, and sorting.
- Atomic update operators, positional updates, typed array-filter helpers, and validated upserts.
- Sessions, transactions, operation deadlines, and cancellation.
- Application-owned codecs and semantic field metadata.
- Generated MongoDB validators and index declarations, deployed explicitly.

Mica handles data access. Workflows, authorization, event delivery, soft deletion, and other application policies belong in your application. The [task completion example](examples/workflows/complete-task.ts) shows a transaction that updates a document and records an outbox event.

## Development

Requires Node.js 22.13+ and Docker for integration tests.

```sh
npm ci
npm run check
```

The full check runs lint, formatting, TypeScript fixtures, unit tests, real MongoDB integration tests, and an isolated consumer test of the packed library. Integration tests create a disposable replica set on a loopback port and remove it afterward. No external database or credentials are needed. Opt-in [local load and recovery tests](docs/stress-testing.md) measure workloads and exercise a three-member replica set.

See [CONTRIBUTING.md](CONTRIBUTING.md) for focused checks and [the examples guide](examples/README.md) for a runnable demo.

## Current boundaries

- Upserts use equality filters with `$set`, `$setOnInsert`, and `$inc`, and require a valid complete insertion candidate.
- Query paths have a five-level traversal budget; map entries are atomic paths.
- `$addToSet` supports scalar values without codecs. `$pull` also supports embedded-object predicates.
- Codec-backed values cannot be assumed to support application-value comparisons.
- Projections and `immutable()` are toolkit behavior, not database authorization.
- Validators and indexes are not installed automatically. Raw driver access bypasses toolkit behavior.
- Aggregation supports a [defined set of read stages](docs/api.md#aggregation); arbitrary expressions, joins, and write stages require the raw driver.
- Update pipelines, replacement methods, population, and document lifecycle hooks are not part of the current API.

See the [API reference](docs/api.md) and [roadmap](docs/roadmap.md) for details.

## Contributing and security

Bug reports with a small reproduction, documentation improvements, and focused fixes are welcome. Read the [contribution guide](CONTRIBUTING.md), [code of conduct](CODE_OF_CONDUCT.md), and [security policy](SECURITY.md).

## License

[Apache-2.0](LICENSE).
