# Roadmap

Mica is in early development. Work is guided by concrete application needs, reproducible tests, and a small persistence-focused API.

## Implemented

- Local load/memory checks and three-member recovery tests, including transaction retries and uncertain commits.
- Pinned runtime/compiler compatibility jobs and installed-package consumer tests with compiler budgets.
- Typed schemas, custom values, codecs, metadata, constraints, and generated validators.
- Explicit index declarations, including partial, unique, sparse, and TTL indexes.
- Shared schema comparison tooling and explicit `mica check`, `mica diff`, and confirmed `mica push` for validators and indexes.
- CRUD, existence/count/distinct queries, bulk operations, cursors, and projected chunks.
- Immutability, nested projections, maps, and positional updates.
- Restricted upserts including `$inc`, sessions, transactions, deadlines, and cancellation.
- Structured validation errors and optional typed array-filter builders.
- Typed read aggregation with match, project, group, sort, skip, limit, and count stages; numeric accumulators and inferred results.

## Before a stable release

The first [API contract audit and generated correctness pass](api-contract-audit.md) is complete. It establishes a baseline, with remaining release gates tracked below.

- Expand generated combinations and local load measurements into longer soaks and representative application workloads.
- Expand beyond local process crashes/elections to asymmetric network partitions, prolonged outages, and independent hosts.
- Resolve or explicitly bound the pinned driver’s retry-selection timeout limitation.
- Resume hosted [compatibility CI](compatibility.md) when requested; hosted execution is currently deferred.
- Set the public package namespace, version policy, and release process.
- Assess API stability and editor responsiveness in larger consuming applications; installed-package compiler budgets now cover up to 100 entity modules.

## Deferred capabilities

Further aggregation stages/expressions and streaming, update pipelines, replacement methods, and ID convenience methods remain deferred. Population, model methods, application hooks, and business lifecycle systems are outside the current design.
