# Verification approach

The library has compile-time, unit, real MongoDB, and package-consumer checks. Passing these checks supports a controlled application trial; it does not establish general production readiness.

`npm run check` runs lint, formatting, type fixtures, unit tests, MongoDB integration, build, and a packed-package consumer smoke test.

The [API contract audit](api-contract-audit.md) records the first correctness pass, fixed mismatches, covered public surfaces, and remaining release gates. `npm run test:generated` runs its seeded differential suite independently; the same suite is also part of the normal check.

## Persistence evidence

Integration tests cover CRUD and bulk operations, codecs, constraints, projections, map and positional updates, restricted upserts, concurrent counters, transaction conflicts and retries, rollback, TTL expiration, and connection recovery. Typed aggregation checks grouping, numeric accumulators, nested projections, hidden fields, codec decoding, ordered sorts, sessions, deadlines, and cancellation. A generic task workflow verifies that a document transition and outbox insertion commit together.

The generated suite compares 64 schema combinations with independently constructed native-driver storage and application-value collections. It exercises 480 projection configurations across five read surfaces, defaults, nulls, nested codecs, seeded updates, returned documents, bulk writes, aggregation, and ObjectId matching. Invalid-input regressions verify that validation runs before commands are sent. Seeds and case numbers make failures replayable; this is a bounded matrix, not exhaustive fuzzing.

Tests create a disposable single-node replica set and explicitly install validators/indexes where needed. Test-only failpoints delay commands to exercise deadlines and cancellation. Containers are removed after the run. No external database or credentials are required.

## Type and package evidence

Compile-only fixtures check inferred insert/selected/stored types, projections, aggregation stage/result shapes, and invalid inputs. The package smoke test unpacks a built tarball into a temporary consumer, checks runtime imports and exported declarations (including aggregation), and removes temporary files afterward. The package contains built output, the README, and license notices.

Separate [compatibility jobs](compatibility.md) install the actual tarball with fresh dependencies and compile all public type fixtures/examples with declaration checking enabled. Six generated consumers per compiler cover up to 100 distinct entity modules, each with its own query module. TypeScript 5.9.3, 6.0.3, and 7.0.2 are pinned, with compiler budgets and retained diagnostic/dependency reports. The first run exposed and fixed excessive instantiation in recursive logical filters.

## Remaining work

Local load/memory and three-member crash/election tests now provide the bounded evidence below. Longer soaks, representative application data and traffic, independent hosts, asymmetric partitions, deployment-specific pools, and migration/rollout still need validation. The pinned driver’s retry-selection timeout behavior remains a documented dependency limitation.

## Latest local verification

On 2026-10-03, the complete check passed in the working checkout: 67 unit tests, 121 MongoDB tests (including 64 generated schema cases), compile-time fixtures, lint, formatting, build, and the packed-package consumer check. The generated matrix passed with the default seed 1372200998 and an additional seed 1. The local toolchain was Node.js 22.13.0, TypeScript 7.0.2, and the pinned MongoDB 8.2.2 image.

The earlier public-repository preparation also passed in a fresh directory after `npm ci`. GitHub CI now declares four Node/server combinations plus three separate compiler consumer jobs; hosted CI has not run yet. Hosted compatibility execution is deferred at the maintainer’s request. The local stress pass below does not establish general deployment readiness.

The compatibility pass on the same date passed `npm run check` on Node.js 22.13.0 and 24.21.0 with MongoDB 8.2.2. All 121 integration tests also passed on MongoDB 8.0.15 with each Node version, completing the four local runtime combinations. All three TypeScript versions passed the installed-package contracts and six generated consumers per compiler, including their diagnostic budgets. These local runs do not substitute for the pending hosted CI runs.

## Local load and recovery pass

On 2026-10-03, `npm run check` passed after the lifecycle fix: **68 unit tests and 121 integration tests**, plus type fixtures, lint, formatting, build, and package checks. The new local commands are documented in [stress testing](stress-testing.md).

A 120-second measured load pass with 16 workers, 2,000 documents, and 8 KiB codec payloads passed exact write accounting and read-value assertions. It acknowledged **93,014 increments**, matching the stored counter sum. On this Docker Desktop environment (Linux ARM64 client, Node.js 22.13.0, MongoDB 8.2.2, driver 7.7.0; Docker reported 11 CPUs and approximately 6.84 GiB RAM):

| Phase                                                  | Workload operations/second |
| ------------------------------------------------------ | -------------------------: |
| Projected reads with codec decoding                    |                     10,069 |
| Atomic increments                                      |                        930 |
| Mixed reads, increments, two-update bulks, aggregation |                      2,321 |

Each phase lasted approximately 40 seconds. A bulk is one workload operation and two increments. These are synthetic local observations, not capacity promises or native-driver comparisons. Client sampled peak RSS was approximately 295 MiB across the workload and subsequent large-document scans. Detailed per-operation latencies and memory are retained in the ignored reports. All server cursors and client application connections returned to their expected counts.

The five recovery scenarios passed on a three-member local replica set. Primary replacement took approximately **2.33 seconds** in the recorded run; all **317 acknowledged majority writes** remained present, while three failed calls were recorded separately. The interrupted transaction ran its callback twice with one committed effect. The uncertain commit ran one callback and two commit commands, also with one effect. Eight queued reads timed out under pool exhaustion, followed by successful recovery. Majority loss and restoration recovered successfully, with zero application connections or checked-out connections after closing the client.

The suite found and fixed a Mica readiness guard that masked native transaction retry errors during an election. It also reproduced a driver limitation: both native and Mica writes configured with a 1.5-second operation timeout took approximately **9.26 seconds** during retry selection; a Mica write with an explicit abort signal took **1.50 seconds**. The timed-out write was present after recovery, confirming why failures must not be interpreted as rollbacks. See the [timeout limitation](stress-testing.md#observed-driver-timeout-limitation) before relying on hard deadlines.

A focused follow-up verified the refined memory measurement after releasing each scan’s result frame before GC: incremental heap peaks were about 32.3 MiB for `find`, 11.1 MiB for cursors, and 14.7 MiB for chunks on the 32 MiB payload dataset. Retained growth after the repeated scans and early exits was approximately 0.43 MiB. These are observed heap samples, not peak RSS guarantees. A handled SIGINT during an active workload also removed every run-owned container and network and recorded the interruption as a failed run.
