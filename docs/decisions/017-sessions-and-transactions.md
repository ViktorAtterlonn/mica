# ADR 017 — Explicit sessions and transactions

Every collection operation accepts a native `ClientSession` through `{ session }`: reads, cursors, chunks, distinct/count/exists, insertions, updates, deletions, returned-document writes, and bulk batches. A bulk uses one session for the whole call, not per-entry sessions. Ended sessions reject. The driver enforces client ownership, topology support, transaction read preference, and native session constraints.

`db.startSession(options?)` creates an explicitly owned session after connection; the caller ends it. `db.withTransaction(async session => ..., options?)` creates a session, delegates transaction retry/commit/abort behavior to the native driver, returns the callback result, and always ends the session. Pass the provided session to each participating operation. Operations that omit it remain outside that transaction.

Keep sessions alive until lazy cursors and chunks finish. Transaction callbacks may run more than once under native retry rules; external side effects and domain workflow orchestration remain application concerns. Do not run concurrent operations on one transaction. Mica adds no custom retries or ambient session state.

The integration runner now creates a disposable single-member replica set, with loopback-only access and unique container/database names. Tests verify uncommitted read visibility, read-your-writes across all read forms, explicit session propagation, commits, rollback on application errors, and ended-session rejection. Existing codec, parity, TTL, and connection-recovery tests continue on the same isolated topology.
