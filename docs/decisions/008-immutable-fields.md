# ADR 008 — Immutable fields

## Decision

Fields support `.immutable()` independently of encryption. The modifier preserves its flag through other modifiers and custom-type bases, without mutating reusable builders. Immutable fields remain readable.

`.immutable()` permits insertion (including defaults) and rejects subsequent direct updates or writes through immutable ancestors. Whole-object and whole-array `$set` replacements containing immutable or generated descendants are also rejected, even if the supplied value claims to be identical. This avoids a preliminary read, comparison races, or silent stripping. Update types exclude those paths; runtime checks protect JavaScript and cast callers. Returned plain objects remain locally mutable.

An array containing immutable children can receive new elements via `$push`/`$each`; those elements are new insertions. Mark the array itself immutable to prevent appends. `_id` and generated fields retain their existing protection. Descendant protection checks are not truncated at the five-level dot-path typing limit.

These are toolkit write rules, not database authorization. Raw driver access bypasses them. Generated MongoDB validators remain structural; they do not compare old and new values. All write methods must apply the same immutable-path checks.

## Validation

Unit and compile-only tests cover modifier composition, immutable ancestors, parent replacements, array appends, schemas with no writable paths, and protection below the dot-path limit. Real MongoDB tests verify stored updates and confirm that rejected immutable writes send no update command.
