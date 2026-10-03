# ADR 026 — Typed array-filter builder

`arrayFilter(identifier, arrayField, predicate)` builds a native predicate document with types inferred from the selected array's element schema:

```ts
await db.records.updateOne(
  {},
  { $inc: { 'rows.$[row].score': 1 } },
  {
    arrayFilters: [arrayFilter('row', Records.rows, { score: { $gte: 3 } })],
  },
);
```

Embedded object predicates use relative field names, including logical branches; scalar arrays accept scalar values/operators. The builder prefixes the identifier, validates the predicate and codec restrictions, and returns an independent BSON snapshot. It does not encode filter values.

This is optional syntax sugar for the existing `arrayFilters` option. Raw native-shaped documents remain accepted and runtime-validated. Identifier-to-update-path correlation still happens at runtime, including checks for missing, unused, duplicate, or mismatched identifiers. The helper infers types from the explicitly selected array field rather than expanding every possible update/identifier combination in collection method generics.
