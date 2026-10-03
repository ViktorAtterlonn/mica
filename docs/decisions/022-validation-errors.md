# ADR 022 — Structured input validation errors

Mica's document, update, filter, projection, map-key, and query-option checks throw the exported `MicaValidationError`. It extends `Error` with a stable `code` and a `path` identifying the affected field or operation. Nested insertion paths include object keys and array indices, for example `profile.rows.0.name`.

Codes distinguish missing/unknown fields, invalid values/types/options, immutable fields, conflicting paths, unsupported operations, invalid updates/projections, and invalid map keys. Messages remain human-readable; applications should branch on the code, not parse text. Some operation-wide errors identify `update`, `upsert`, `projection`, or `options` rather than a single field.

Native MongoDB failures, cancellation reasons, application codec/default/validator exceptions, schema-definition errors, connection-state failures, and stored-data decoding failures keep their existing identity. Mica does not reclassify a duplicate-key error or user exception as an input validation failure. Input values are not retained on the error.
