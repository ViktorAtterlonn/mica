# Frequently asked questions

## Why was Mica built?

Mica was built to bring schema-driven type safety, precise projection types, and reusable custom fields to MongoDB through Drizzle-inspired syntax.

A document can have several shapes: an insert may omit fields with defaults, a query may select only a few fields, and an encrypted value may be stored differently from the value your application uses. Mica describes these boundaries in one schema and uses it for inferred types, supported input validation, codecs, and generated MongoDB validators.

The goal is for your editor to understand the operation you are actually writing: which values can be inserted, which paths can be updated, and which fields a query returns. Codecs and metadata let you extend the field vocabulary while preserving those types. See the [design](design.md) for the boundaries behind that choice.

## What does type safety cover?

One schema drives insert, selected, stored, filter, update, and projection types. Defaults affect which insert fields are required; codecs distinguish application values from stored values; immutable fields constrain updates; explicit projections shape read types.

This applies to Mica's supported typed API. Type assertions, `any`, raw driver calls, and data written by other clients can bypass those guarantees. Query paths have a five-level traversal budget, and some MongoDB operations are outside the current API. The [API reference](api.md) documents these limits.

## Are projections type-safe too?

Yes. A literal projection changes the inferred result shape:

```ts
const tasks = await db.tasks.find({}, { projection: { title: 1, _id: 0 } });
// { title: string }[]

for (const task of tasks) {
  console.log(task.title);
  // task.state would be a TypeScript error: it wasn't selected.
}
```

You do not need to declare a separate result interface or cast a partial document to the full entity type. Nested object and array projections also participate in inference. Reused projection objects need literal values, for example with `as const`; widened or dynamic projections are outside the current API.

## What can custom fields do?

`customType()` lets you package a base field together with metadata, a storage codec, or both, and reuse it across entities.

Metadata describes meaning: a `translatable` marker can identify fields for your translation tooling through `discoverMetadata()`. A codec converts values: an encrypted field can accept and return a string while storing BSON binary data. Mica infers the application and storage types separately, and the custom field retains base modifiers such as `.optional()`.

Metadata does not run application jobs. Codecs perform synchronous value conversion on supported operations; your application supplies the conversion and any encryption keys. See [custom types](api.md#custom-types) for the contract and examples.

## What is inspired by Drizzle?

The schema declaration style: composable field builders, chained modifiers, exported entity declarations, and types inferred from those declarations. The aim is a compact syntax that reads naturally in TypeScript.

Mica is an independent MongoDB toolkit. It is not a Drizzle adapter and does not implement Drizzle's SQL query API. Queries use MongoDB filters and update operators.

## How is Mica different from Mongoose?

Mica emphasizes schema-derived types across supported operations, projection-aware results, custom fields with codecs and metadata, and Drizzle-inspired declarations. It uses the official MongoDB driver directly and does not depend on Mongoose.

| Area                 | Mica                                                                                 | Mongoose                                                            |
| -------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Returned documents   | Plain objects with selected fields decoded                                           | Hydrated documents by default; plain objects with `lean()`          |
| Writing changes      | Explicit collection operations such as `updateOne()`                                 | Collection-style updates and document mutation followed by `save()` |
| TypeScript           | Schema inference for insert, selected, stored, filter, update, and projection shapes | Official TypeScript support with automatic schema inference         |
| Application behavior | Ordinary functions and explicit transactions                                         | Also offers document methods and middleware                         |

Mongoose documents provide change tracking and document methods. Mongoose also supports plain-object reads through [`lean()`](https://mongoosejs.com/docs/tutorials/lean.html), [TypeScript inference](https://mongoosejs.com/docs/typescript.html), and [middleware](https://mongoosejs.com/docs/middleware.html). Those are useful options; Mica chooses a smaller API centered on collection operations.

Mica's tradeoff is a narrower feature set. Its aggregation builder supports a defined set of stages with inferred results. Population, document hooks, replacement writes, and update pipelines are outside its typed API. Check the [API reference](api.md) before choosing it for a particular workload.

## Does aggregation preserve type safety?

Yes, through the [supported builder stages](api.md#aggregation). `db.products.aggregate().match(...).group(...).project(...).toArray()` infers the result as the shape changes. Later stages cannot refer to fields removed by earlier stages, and codec-backed values cannot be used as group keys or numeric accumulator inputs.

The builder supports filtering, projections, scalar grouping with numeric accumulators, sorting, pagination, and counting. Arbitrary expressions and joins still require the raw driver; Mica does not pretend to infer an arbitrary native pipeline from a result type supplied by the caller.

## Can I pass ObjectId strings to aggregation matches?

Yes. If `organizationId` is an ObjectId field, `.match({ organizationId: '507f1f77bcf86cd799439011' })` converts the string before sending it to MongoDB. Nested predicates and membership operators such as `$in` work too. Malformed ObjectId strings fail with a field-specific validation error; returned values remain ObjectIds.

[Mongoose documents that aggregation stages are not cast](<https://mongoosejs.com/docs/api/aggregate.html#Aggregate()>). A general pipeline can change a field's type, so using the original collection schema throughout would be unsafe. For example, grouping by a string category replaces the original ObjectId `_id` with that category string.

Mica's builder tracks the schema through its supported stages. Conversion follows the current field type, so actual string fields stay strings, including a new `_id` produced by grouping. This convenience applies to typed aggregation matches; raw pipelines and ordinary query/write inputs keep their existing behavior.

## What are update pipelines?

An update pipeline computes changes from the current document using aggregation expressions. For example, this native MongoDB update sets a total from two existing fields:

```ts
// Native driver collection, operating on stored values.
await raw.updateMany({}, [{ $set: { total: { $multiply: ['$price', '$quantity'] } } }]);
```

Here `'$price'` refers to a field; a normal operator update such as `{ $set: { total: 100 } }` assigns a supplied value. Update pipelines can also copy fields or calculate conditional values. They support a restricted set of stages, not every aggregation stage. See [MongoDB's update pipeline guide](https://www.mongodb.com/docs/manual/tutorial/update-documents-with-aggregation-pipeline/).

Mica's `aggregate()` builder reads and transforms query results. Update pipelines write changes and remain outside Mica's typed update API. Raw driver updates bypass Mica's codecs, timestamps, and immutability checks, so their storage behavior is application-owned.

## Why not just use Mongoose with `lean()`?

That can be a good fit, especially for an existing Mongoose application. Plain-object reads alone are not a reason to migrate.

The reasons to consider Mica are its inferred projection results, reusable custom fields with separate application and storage types, discoverable metadata, and declaration syntax. Plain objects and explicit collection operations support that design. Choose it when that combination matches how you want to structure your application.

## Why not use the MongoDB driver directly?

Use the driver directly when you want its full API and prefer to manage your own validation, defaults, and storage conversions.

Mica adds a shared schema for those concerns, typed paths and projections, and helpers such as projected chunks. Native sessions and MongoDB operations remain visible. Raw driver access is also available, but it bypasses Mica's defaults, codecs, projection checks, and write checks.

## Where do business logic and hooks go?

Put business actions in application functions that call collection methods. For example, completing a task can update its state and insert an outbox event in one transaction. See the [task completion example](../examples/workflows/complete-task.ts).

Mica handles persistence defaults, timestamps, and value codecs on supported operations. Your application owns authorization, workflow rules, notifications, encryption keys, and event delivery. The [lifecycle boundary](application-lifecycle-boundary.md) explains this division.

## Does TypeScript replace runtime validation?

No. TypeScript cannot validate incoming JSON or existing database contents.

Mica validates supported write inputs at runtime and generates MongoDB validators from the stored schema. You install those validators explicitly. Some constraints, such as the resulting value after an increment, require server validation. Reads decode selected values without checking every document against the full schema.

## Can I use Mica with an existing database?

Yes, if your declarations match the stored data. Mica does not require a new database or automatically migrate existing documents. Index and validator deployment are explicit.

A Mongoose migration requires more than replacing imports. Check collection names, BSON types, IDs, defaults, indexes, storage codecs, and any behavior implemented through hooks or plugins. Test representative stored documents and writes before switching application paths. Mica is not a drop-in replacement.

## Is Mica faster than Mongoose?

There is no comparative benchmark establishing that. Plain objects avoid document hydration, but Mongoose also offers `lean()`, and Mica performs its own validation and codec work. Measure representative queries, projections, and writes in your application rather than assuming a performance advantage.

## Is Mica ready for production?

Mica is in early development. It has type checks, unit tests, real MongoDB integration tests, and package-consumer checks, but its API may change and the current API has deliberate limits.

Start with a controlled application trial. Review the [current boundaries](../README.md#current-boundaries), [verification report](hardening-report.md), and [roadmap](roadmap.md). If your application depends on features Mica does not provide, keep the library or driver that supports them.
