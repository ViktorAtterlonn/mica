# ADR 002 — Bounded schema paths and literal whole-field projections

Status: accepted for Phase 0. Date: 2026-10-01.

## Prior art and experiments

Papr identifies the driver's Document index signature as a source of overly permissive strict query types. Its own query types narrow that behavior. [Papr mongodbTypes.ts](https://github.com/plexinc/papr/blob/main/src/mongodbTypes.ts)

Papr also bounds nested paths and computes projection-dependent results; its utilities describe compiler recursion problems for some generic operation types. This supported testing compile behavior early. [Papr utils.ts](https://github.com/plexinc/papr/blob/main/src/utils.ts)

The first spike approach generated a union of path strings, then recursively looked each path up a second time. TypeScript 7.0.2 reported TS2589 while checking generic filters and updates. A second attempt to instantiate the complete projection signature in the generic driver implementation also produced TS2589. These were internal implementation failures, not evidence that the requested public API was impossible.

Replacing the repeated lookup with bounded `{ path, field }` entries and keeping driver implementation types erased at one documented assertion boundary fixed both failures. `tests/types.ts` checks concrete invalid operations; `scripts/bench-types.mjs` measures 1/100 collections at depths 3/5/8. No errors are suppressed in library code.

## Decision

Later extensions include [positional update paths](020-positional-updates.md), [nested projections](019-nested-projections.md), and [typed dynamic map entries](021-dynamic-maps.md). The original bounded-path reasoning below remains applicable.

Walk schema structure rather than arbitrary application objects. BSON values and primitive custom values are leaves. Stop type expansion after five traversal levels (arrays consume a level); expose deeper data as complete objects rather than accepting arbitrary deep strings. Filter operands reuse selected MongoDB `AlternativeType`/`FilterOperators` types without the Document index signature. Supported operators retain MongoDB names and shapes.

`$inferUpdate` is an operator document containing application-level `$set` and `$push` values. Replacing a nested document or appending an element takes its insert shape, so nested defaults remain useful. Generated fields and root `_id` cannot be direct update targets. Positional and numeric array writes are deliberately absent.

Projections are literal top-level 0/1 maps. Inclusion, exclusion, `_id`, empty projections, optional fields, and whole nested arrays/objects have compile and integration coverage. Widened projections are rejected instead of promising full documents. Runtime checks reject mixed modes and unknown fields even if callers cast around TypeScript.

## Alternatives and follow-up

Native Filter alone is too permissive for the spike's negative tests. Copying a large third-party query type suite would expand operator promises beyond the runtime codec implementation. Unlimited recursive paths risk compiler failure.

Dotted projections need a separate deep-pick/deep-omit design for arrays and optional parents. Codec query capability is currently checked at runtime; a future scalar-codec capability parameter could reject unsupported value filters at compile time as well. TypeScript remains structurally typed: excess properties in pretyped variables may pass the compiler, so runtime write checks remain necessary. Editor responsiveness and heterogeneous production schemas still need measurement.
