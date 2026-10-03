# Local load and recovery testing

These opt-in checks exercise Mica's built JavaScript against disposable MongoDB containers. They are separate from `pnpm run check` and are not added to CI.

```sh
pnpm run test:load
pnpm run test:recovery
```

Use a running Docker daemon and allow image/npm downloads on the first run. The runner uses MongoDB 8.2.2 and Node.js 22.13.0 by default. `MICA_MONGO_IMAGE` overrides the server image. It creates a uniquely named private Docker network, one database member for load tests or three voting data-bearing members for recovery, and a client container with freshly installed production dependencies. Database ports are not published. The runner accepts no external database URI.

Each run writes reports to `.tmp/stress/load-TIMESTAMP/` or `.tmp/stress/recovery-TIMESTAMP/`. `run.json` records images, fault actions, execution and cleanup status; `results.json` records scenarios, measurements, and failures. MongoDB log tails are retained for diagnosis. Containers, their anonymous volumes, the network, and the temporary client installation are removed on completion, failure, or a handled interrupt. Forced termination of the host process cannot guarantee cleanup; the run's `mica-stress-UUID` names identify its resources.

## Load workload

The default run seeds 2,000 synthetic documents with 8 KiB codec-backed payloads and runs eight concurrent workers. Thirty measured seconds are divided equally between read, write, and mixed phases, after seeding and connection warmup. Writes use majority acknowledgement. The mixed phase cycles through two projected reads, one increment, one two-update bulk, and one grouped aggregate. Each read explicitly selects and checks its decoded payload. Explicit exclusion and codec decoding have separate correctness coverage.

```sh
MICA_LOAD_SECONDS=120 MICA_LOAD_WORKERS=16 pnpm run test:load
MICA_LOAD_DOCUMENTS=10000 MICA_LOAD_PAYLOAD_BYTES=8192 pnpm run test:load
```

Bounds: duration 6–1,200 seconds, workers 1–64, documents 100–100,000, payload 0–262,144 bytes, with at most 256 MiB of seeded payload. The deadline controls when workers stop starting operations; in-flight operations finish before phase metrics are recorded. A bulk counts as one workload operation and two increments. This is a closed-loop workload with bounded concurrency, so it does not measure latency under an unbounded incoming request rate.

Checks include:

- Every measured operation must succeed; read values and write match counts are checked.
- Final document count and summed counters must equal the seed and acknowledged increments exactly.
- Per-operation p50/p95/p99 latency and phase throughput are recorded using a bounded-memory logarithmic histogram. Percentiles are bucket upper bounds, not exact samples.
- Process RSS, heap, external and array-buffer memory are sampled; event-loop delay and connection-pool usage are recorded.
- A separate 32 MiB payload collection (128 documents × 256 KiB) is scanned three times each through `find`, a cursor, and chunks. All decoded payloads are checked. Per-scan heap and duration are recorded.
- Early exits from cursors/chunks must leave no extra server cursors. Post-GC retained heap growth after repeated scans must stay below a broad 64 MiB leak guard. Client application connections and checked-out connections must return to zero on close.

Timing and memory are observations, not universal performance guarantees. No throughput threshold is enforced across different machines. The leak guard detects large retention regressions; it does not prove the absence of small leaks. RSS sampling can miss brief peaks, forced-GC results are diagnostic, and this fixture is not a multi-hour soak or a native-driver comparison. Run measurements without unrelated workloads for useful comparisons.

## Three-member recovery scenarios

All members have equal priority; election timeout is shortened to two seconds to keep local tests practical. The driver uses normal replica-set discovery with retryable writes. The suite verifies:

1. **Primary process crash during writes.** Four workers insert unique IDs while the host kills the primary process. Another member must become primary, writes must resume, and every acknowledged majority write must remain present. Failed calls are recorded separately because their outcome can be ambiguous. The former primary is restarted and checked for catch-up.
2. **Election inside a transaction.** The primary steps down after the callback's first write. The callback must retry and leave exactly one ledger entry and one counter increment.
3. **Uncertain commit response.** A targeted server failpoint attaches a write-concern error with `UnknownTransactionCommitResult` to one commit response. Command monitoring must observe the uncertain response and a repeated commit command, while the callback runs once and effects appear once.
4. **Pool exhaustion.** A targeted failpoint holds a read on a one-connection pool. Queued reads must fail with the driver's wait-queue timeout; after the blocked command completes, reads must succeed and connections must close.
5. **Loss of majority.** Both secondaries are killed. Mica and native-driver writes run together with a 1.5-second operation budget, alongside a Mica write with an explicit 1.5-second abort signal. All must fail; native retry-selection behavior is recorded against a combined 12-second ceiling, while explicit cancellation must complete within four seconds. After members restart, the client must recover. The test inspects whether the timed-out write exists rather than assuming failure means rollback.

The transaction checks follow the driver's distinction between retrying a transaction callback and retrying an uncertain commit. See the [MongoDB transaction retry contract](https://www.mongodb.com/docs/manual/core/transactions-in-applications/) and [server failpoint documentation](https://github.com/mongodb/mongo/wiki/The-failCommand-fail-point). Failpoints are enabled only on these disposable test servers and scoped by application name where applicable.

## Observed driver timeout limitation

The pinned MongoDB driver 7.7.0 can exceed `timeoutMS` during retry server selection after majority loss. In the local parity run, both Mica and a direct native-driver write configured with `timeoutMS: 1500` failed after approximately 9.26 seconds. The client also had `serverSelectionTimeoutMS: 8000`. Inspection of the installed driver's retry path shows that it reselects a server without the operation timeout context. This is retained as a dependency limitation, not treated as successful enforcement of the requested 1.5-second budget.

In the same outage, supplying `signal: AbortSignal.timeout(1500)` bounded the Mica write to approximately 1.50 seconds. Use a shared abort signal when an application needs cancellation across retries, and configure server-selection budgets deliberately. Neither timeout nor cancellation proves that a write did not commit. The regression records native parity and requires bounded cancellation; it does not add a detached `Promise.race` around ongoing database writes. Reassess this limitation before promising hard operation deadlines or changing driver versions.

## Limits

A three-container replica set on one Docker host does not reproduce three independent machines or availability zones. Process crashes and elections do not cover asymmetric network partitions, disk-full/corruption, prolonged outages, sharded transactions, or deployment-specific TLS/authentication and pool sizing. The uncertain-commit case injects a server response; it is not a real lost TCP response after commit. Results support the tested contracts and configuration, not a blanket production-readiness claim.
