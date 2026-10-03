# ADR 015 — Explicit query and write options

Read operations accept `collation`, `hint`, and `readPreference`: find, cursor, chunks, findOne, exists, countDocuments, and distinct. Update/delete operations and their bulk entries accept collation and hint. Returned-document writes remain writes and do not accept read preference. Supported options are explicitly listed and validated rather than forwarding arbitrary driver options.

Hints accept an index name or key document with ascending, descending, or hashed directions. The server determines whether the index exists and can serve the query. Collation uses the driver's collation shape and requires a locale; server-specific locale/options validation remains with MongoDB. Read preference accepts a driver mode or ReadPreference instance. Collation, hints, and read preference tags are copied so lazy cursors/chunks do not observe later caller mutation.

Native command behavior and errors are preserved. In particular, distinct hint support depends on the server (MongoDB 7.1+). The tests use MongoDB 8. Named hints on returned-document operations are forwarded despite the installed driver's narrower TypeScript hint declaration; real-server tests verify that path.

Integration evidence covers case-insensitive reads, counts, distinct, chunks, multi-updates, returned documents, bulk updates, and deletion through a named collation index. Invalid read preferences and read preferences on writes reject.
