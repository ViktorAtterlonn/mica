# ADR 021 — Typed dynamic map entries

`map(valueField)` describes a BSON object whose keys are dynamic and whose values share one field schema. Application, insertion, stored, and selected types are records of the corresponding value shape. Nested object defaults and scalar codecs run per value. JSON Schema uses constrained pattern properties and the stored value schema.

Individual entries are addressed with `mapField.key` in filters, updates, distinct, and projections. Number entries support arithmetic, entries can be set or removed, and array-valued entries support array operations. Missing keys are allowed; removing an entry does not require `.optional()` on the value field. Entries with immutable/generated values or descendants retain the existing write restrictions.

An entry is an atomic path for this initial API: object-valued entries can be replaced or queried as complete values, but their internal dynamic subpaths are not exposed. Keys must be nonempty, cannot start with `$`, contain dots/null bytes, or be prototype-related names. TypeScript narrows entry values; runtime validates dynamic key strings. Selected named entries are optional in projected types because that key may be absent.

Map containers can use `select(false)`. Hidden descendants within map values are rejected at definition time because a MongoDB projection cannot exclude that field for every unknown key. Hide the whole map and explicitly select it or a named entry when needed. Codec-containing entries reject value comparisons/distinct, while ordinary writes and selected reads encode/decode them. Dynamic-key index declarations are deferred; the map root remains indexable and native index declarations remain available explicitly.

The separate browser-usage entity demonstrates numeric counters and structured session entries. Compile/unit/MongoDB tests cover value types, defaults, Unicode and invalid keys, codecs, immutable values, entry updates/removal, inferred projections, and generated server validation.
