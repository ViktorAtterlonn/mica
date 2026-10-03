# ADR 019 — Nested field projections

Literal 0/1 projections support bounded schema paths through objects and embedded arrays. Inclusion builds a deep result type containing only selected leaves; exclusion removes those leaves from the complete application shape. Optional/nullable parents and arrays retain their structure. Selecting a whole container still includes its whole application value. Root `_id` keeps MongoDB's inclusion/exclusion exception.

Explicit projections run server-side before decoding. Parent/child projection collisions, mixed modes, expressions, positional/numeric array paths, and traversal inside atomic codec values reject before a query.

Decode visits only returned fields, so unselected encrypted values are never decrypted and missing defaults are not materialized. The same contract applies to find/findOne, cursors, chunks, and returned-document writes, including metadata results. Chunk pagination keeps its internal ID separate from the outward projection.

Compile tests cover nested inclusion/exclusion and optional parents. MongoDB tests verify embedded arrays, explicit codec inclusion, decoder call counts, nested exclusions, collision rejection, and projected chunks.
