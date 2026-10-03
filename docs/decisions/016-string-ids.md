# ADR 016 — String and ObjectId identities

Collections accept required, non-null `string()` or `objectId()` IDs without codecs. ObjectId generation remains `.auto()`. String IDs must be supplied or use a normal string default factory. ID types propagate to inserted IDs, update upserted IDs, filters, selected documents, and chunk checkpoints. Root `_id` remains immutable in updates.

Chunks validate every stored ID against the schema and require strict ascending progress. String checkpoints are compared in UTF-8 binary order, including empty strings and supplementary Unicode characters. String-ID scans explicitly use simple collation, and reject other collations, so comparison agrees with MongoDB independently of collection defaults. ObjectId scans preserve the existing behavior. Projections can still omit IDs without breaking pagination.

Integration tests cover empty/Unicode string IDs, typed insertion results, complete scans, resuming after an empty-string checkpoint, projection, wrong ID types, and incompatible collation. Compile tests prevent ObjectId checkpoints on string collections and missing required string IDs.
