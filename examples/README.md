# Examples

Entities are declared globally in separate modules. The examples import the local `@mica/db` workspace, so build it before running them. No package publication is needed.

- [Products](entities/products.ts) and [organizations](entities/organizations.ts): embedded objects, arrays, references, codecs, and indexes.
- [Browser usage](entities/browser-usage.ts): string IDs and typed dynamic maps.
- [Outbox events](entities/outbox-events.ts): an explicitly deployed TTL index.
- [Tasks](entities/tasks.ts) and [task events](entities/task-events.ts): a [transactional completion workflow](workflows/complete-task.ts).
- [Encrypted field](fields/encrypted.ts): an application-defined storage codec. The random process-local key is for tests and demonstrations only; stored values will not be readable in another process.
- [Translatable field](fields/translatable.ts): semantic metadata without automatic application work.
- [Product summary](queries/product-summary.ts): typed aggregation with tenant filtering, grouping, sums, and inferred result fields.

## Run the quickstart

Start a local test MongoDB instance, then run:

```sh
pnpm run build
MICA_EXAMPLE_URI=mongodb://127.0.0.1:27017 pnpm exec tsx examples/quickstart.ts
```

The demo creates a uniquely named database, inserts and updates synthetic data, and drops only that database on exit. Use a test instance. The full integration suite manages its own disposable Docker replica set:

```sh
pnpm run test:integration
```

The task workflow test checks concurrent requests, tenant filtering, rollback on an outbox failure, complete default reads, and projected exports. The workflow records events but does not deliver them externally.
