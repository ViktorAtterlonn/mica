# ADR 014 — Schema-aware MongoDB filters

Filters now support `$all`, `$size`, `$not`, `$type`, `$regex`/`$options`, and `$elemMatch` across all query and update-filter entry points. Existing equality, range, membership, existence, and logical operators remain supported. Explicit regex accepts strings or RegExp with MongoDB flags `i`, `m`, `s`, `x`, `u`; options require a regex. BSON type aliases/codes or nonempty arrays of them are accepted.

`$all` and `$size` target arrays. `$all` initially accepts literal members, not its embedded `$elemMatch` form; use a direct `$elemMatch`. `$size` must be a nonnegative safe integer. `$elemMatch` on object arrays receives a filter relative to the element fields; scalar arrays receive operators. This preserves same-element matching and nested operand inference. `$not` accepts a regex or a nonempty operator document.

Codec value comparisons remain rejected. Structural `$exists`, array `$size`, and recursively validated `$elemMatch`/`$not` can inspect safe structure or non-codec siblings without running any codec. Nested encrypted comparisons remain rejected even under negation or logical branches. BSON `$type` examines stored values, so codec targets are also rejected for it.

These are query predicates, not insertion values: no defaults, encryption, or insertion constraints run on query operands. Runtime validation checks paths/operator structure while TypeScript narrows values. Tests cover compound element predicates, empty arrays, membership, case-insensitive regex, BSON types, negation, and nested codec rejection in unit and disposable MongoDB tests.
