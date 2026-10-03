# ADR 004 — Instance state backed by driver topology and verified pings

Status: accepted, updated after local replica-set testing. Date: 2026-10-01; revised 2026-10-03.

## Evidence

The driver exposes topology-change events through SDAM. They describe server discovery, not guaranteed success of every subsequent operation. [MongoDB monitoring documentation](https://www.mongodb.com/docs/drivers/node/v6.x/monitoring-and-logging/monitoring/)

The real integration test starts MongoDB 8.2.2, connects with driver 7.7.0, performs codec operations, stops and restarts the same server, and observes connected → disconnected → reconnected → disconnected. The first restart test exposed a harness issue: Docker reallocated an automatically published port. Explicitly reserving/publishing a host port made the outage test valid. No connection algorithm change was needed for that failure.

Unit tests control ping completion, connect failure/retry, overlapping connect/close calls, primary versus secondary loss, and stale recovery pings.

## Decision

- `idle` initially. `connect()` sets `connecting`, awaits `MongoClient.connect()` and a primary-targeted `ping` against the configured database, then sets `connected`.
- First success emits `connected`; a later explicit successful connection emits `reconnected`.
- An initial failure sets `disconnected`, reports `error`, and rejects `connect()`. A first failed connection does not emit a fictitious successful connection or disconnection callback. Explicit retry is supported.
- After a successful connection, SDAM loss of all known writable server types sets `disconnected` once. RSPrimary, Standalone, Mongos, and LoadBalancer are recognized; a load-balanced topology is treated as available for probing.
- Secondary loss alone leaves a known primary connected. Losing the primary emits disconnected even if secondaries remain; this status is oriented toward ordinary primary-targeted operations.
- When topology becomes writable again, a successful ping is required before `reconnected`. A topology generation counter prevents a stale probe from confirming a newer topology. Closing also prevents late recovery.
- `close()` sets `closing`, waits for an in-flight connect, closes the client, sets `closed`, and removes only toolkit listeners. It emits `disconnected` if closing a connected instance. `closed` is terminal.
- Connect/close calls coalesce while in flight. Closing a never-connected instance is valid. A supplied client is owned by this database instance and closed with it.
- Operations and new sessions require an initial successful explicit connection and reject while closing/closed. After first connection, `disconnected` is an observation, not an operation gate: driver server selection and deadlines determine availability. This preserves transaction error labels and retries during elections.
- Callbacks are synchronous notifications. Their synchronous exceptions go to `error`; an exception in `error` cannot corrupt cleanup. Database-operation errors reject their own promises.

## Limits and unresolved cases

`connected` is a last-observed availability state, not a guarantee of authorization for collection writes or future success. Ping does not prove all CRUD permissions. Heartbeat detection is delayed by driver monitoring; the application should still handle operation errors.

The opt-in recovery suite now tests real elections and process crashes on a local three-member replica set, alongside synthetic SDAM unit tests. Its first transaction-election run exposed an overly strict readiness guard that replaced a native retryable transaction error with a generic disconnected error. Allowing driver execution after the first successful connection fixed that failure. Sharded clusters, Atlas/load-balanced deployment behavior, and authentication changes remain untested. If a recovery ping fails without a later topology event, automatic probing is not periodically retried; explicit `connect()` can retry. A heartbeat-based recovery retry policy is a Phase 1 question. A supplied MongoClient must use standard BSON deserialization settings and should not be shared across toolkit instances.

No connection aliases or global state were introduced.
