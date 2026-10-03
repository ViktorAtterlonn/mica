# ADR 012 — Distinct values and TTL indexes

## Distinct values

`distinct(path, filter?)` returns a promise of values inferred from the selected schema path. It issues the native distinct operation with the existing filter validation and requires an explicitly connected database. Paths share the five-level traversal budget, including array descent; positional and numeric array paths remain unsupported.

The result follows [MongoDB distinct semantics](https://www.mongodb.com/docs/manual/reference/method/db.collection.distinct/): a selected array contributes its elements, missing fields contribute no value, and stored nulls remain null. Nested arrays are expanded only at the selected outer level. Dotted paths through embedded arrays are supported. Results have no promised order and retain the native command's BSON result-size limit; this is not a cursor or a large-result aggregation replacement.

Targets with codecs, or containers with codec descendants, reject at compile time and runtime. The client never tries to recover application equality by decoding ciphertext and deduplicating it. Non-codec sibling paths remain eligible. Since accepted targets have identical application/storage representations, no codec or default runs on their values.

Naming a path explicitly opts into that value, like an explicit inclusion projection: `select(false)` fields can be requested, and selected whole objects contain their hidden descendants. There is no projection option on this method. Missing optional fields do not add `undefined` to the result type. Nullable values retain `null`.

## TTL indexes

`.expireAfterSeconds(seconds)` returns a new index declaration. It accepts integer seconds from 0 through 2147483647 and preserves unique, sparse, and partial modifiers. Only a single date field or array of dates without codecs qualifies; dotted date paths through embedded objects/arrays are supported. Types reject known invalid targets; runtime checks also reject casts. Existing single-field `_id` restrictions remain.

Zero means expiration at the indexed date. Positive values specify a duration after that date. Date arrays use their earliest date. Missing/null dates do not expire documents. Deletion is asynchronous, performed by MongoDB's background monitor, not an exact-time guarantee. These follow the [MongoDB TTL contract](https://www.mongodb.com/docs/manual/core/index-ttl/).

TTL declarations become `expireAfterSeconds` in fresh native `$indexes` specs. Index installation remains explicit through the native driver; connecting does not create indexes. Changing an installed TTL setting requires an explicit database migration, not schema synchronization. Partial predicates continue to describe stored values. Application lifecycle behavior remains outside Mica.

[The outbox example](../../examples/entities/outbox-events.ts) declares seven-day retention for published events. The application owns publishing and setting the date; the index handles storage retention.

## Evidence

Compile tests cover distinct results, codec exclusions, filters, array paths, and TTL eligibility through modifier chains. Unit tests cover duration validation, runtime target rejection, and declaration immutability. The disposable `mica_distinct` database verifies native distinct values, nested arrays, hidden selection, no codec execution, and rejection before sending commands. `mica_ttl` installs and reads back TTL specs and verifies deletion, partial predicates, missing/null dates, and earliest-date arrays. Its monitor interval is temporarily shortened only inside the disposable test container and restored afterwards.
