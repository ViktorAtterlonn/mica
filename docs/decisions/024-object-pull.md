# ADR 024 — Removing embedded objects

`$pull` accepts a typed partial filter relative to an embedded object array's fields, such as `{ $pull: { responses: { responseId } } }`. Logical predicates and dotted object paths use the same validation as ordinary filters. It works through all update entry points, including bulk writes.

Predicates do not run codecs, defaults, or insertion validation. A safe field may select an object containing other codec-backed fields, but comparing codec-backed values is rejected. Removing elements from an immutable array, or elements containing immutable/generated descendants, remains forbidden.

Scalar `$pull` retains its existing contract. Arrays of maps, nested arrays, and opaque custom values remain unsupported removal targets. `$addToSet` remains limited to scalar elements without codecs. Upsert removal is outside the restricted insertion contract.
