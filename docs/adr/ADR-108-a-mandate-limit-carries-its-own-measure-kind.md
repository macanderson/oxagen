# ADR-108: A mandate limit carries its own measure kind, worked out once at write time

- **Status:** Accepted
- **Date:** 2026-09-19
- **Owners:** kernel, app
- **Related:** Mission Control spec §6.9 part 3 (mandates, limits, the ledger);
  ADR-059 (mandates, the ledger, the consequence roles that gate a grant);
  `apps/app/ARCHITECTURE.md` §9, the 2026-09-16 entries on the unit family and
  on "nothing carries a measure's kind"; issue #3130; `docs/capabilities/`
  entries for `grant_mandate`, `request_mandate`, `update_mandate_limits`,
  `get_mandate`, `list_mandates`
- **Numbering:** 108. ADR-102 through ADR-107 are taken; several parallel PRs
  in the same P1 batch independently drafted an "ADR-104" and were renumbered
  at merge time as each collision surfaced.
- **Delivered by:** `mandateLimitSchema.kind` and `mandateAuthoritySchema.kind`
  (`packages/oxagen/src/mandates/schemas.ts`); `measureKindOf` and
  `legacyMeasureKindGuess` (`packages/rules/src/mandates/measures.ts`);
  `assertToolsDeclareMeasures` returning stamped limits
  (`packages/handlers/src/_mandate.ts`); `withResolvedKinds` in
  `parseMandateRow` (`packages/rules/src/mandates.ts`); `measureValue`
  switching on `kind` (`apps/app/src/data/live/mappers/mandates.ts`)

## Context

A mandate limit measures either money or a count. The gate that enforces a
call against a limit never guesses which: `readMeasure`
(`packages/rules/src/mandates/measures.ts`) reads the tool version's declared
`type` (`amount` or `count`) and switches on it. That declaration is the
fact.

The stored limit does not carry the fact. `mandateLimitSchema` held `perCall`,
`perPeriod`, `period` and `currencyOrUnit`, a string naming either an ISO
4217 currency or a unit of a count, and nothing saying which. Every reader
downstream of the write therefore had to work out money-or-count on its own,
and every one of them but the gate guessed it from `currencyOrUnit`:
`isCurrencyCode(unit)` in `apps/app/src/data/live/mappers/mandates.ts`
(`measureValue`) was the guess, and it was wrong whenever a tool legitimately
declared a **count** denominated in a currency code, `{ type: "count", unit:
"USD" }`, which the handler correctly accepted because the unit matched the
declaration. A whole-unit count of 50 then printed as $0.00: the gate enforced
50 counted units and every screen showed a figure a billion times smaller,
each half self-consistent.

This was the fourth finding of the same shape on the same review lane (#2957,
recorded in `apps/app/ARCHITECTURE.md` §9): a limit's unit disagreeing with
the declaration; `calls` exempt from that comparison; `toMandateList` reading
raw micros as dollars; and this one. Each fix closed the one site it found.
None of them closed the supply of sites, because the supply is not bounded:
any future reader of a stored limit can guess again, and some will guess
wrong, because `isCurrencyCode` answers a question about spelling and the
question is about a fact.

`packages/handlers/src/_mandate.ts`'s `assertToolsDeclareMeasures` already
holds the answer at the one moment every write path passes through it: it
fetches the matched tool's measure declaration to check the limit's unit
against it, and the declaration's `type` is sitting right there, unused past
that one check.

## Decision

### 1. The kind is worked out once, at write time, and stored

`mandateLimitSchema` gains `kind: z.enum(["money", "count"]).optional()`.
`assertToolsDeclareMeasures` now returns `args.limits` with `kind` stamped
onto every entry: `money` for a matched tool's declared `amount`, `count`
for `count`, and `count` for the built-in `calls` measure, which needs no
declaration and is always a count. `grant_mandate`, `request_mandate` and
`update_mandate_limits` persist the *returned* record, not the caller's raw
input, so a client cannot set `kind` itself and the field is never trusted
from the wire; it is recomputed from the declaration on every single write,
including a `limitChanges` edit that never mentions `kind` at all.

`mandateAuthoritySchema` gains `kind`, required (not optional): `readAuthority`
(`packages/rules/src/mandates.ts`) always has a resolved kind by the time it
builds an authority row, because every limit it reads has already passed
through `parseMandateRow` (§3 below).

### 2. Read time never resolves declarations to find the kind

The alternative, having `list_mandates` or `get_mandate` look up the matching
tool declaration at read time, was rejected. It costs a join per mandate on
every read of a page that is read far more often than a mandate is written,
and it is genuinely ambiguous: a mandate's tool patterns can match two tools
that declare the same measure with different types, and a read has no
principled way to pick one. Write time is the only moment with one answer,
because it is the moment `assertToolsDeclareMeasures` already resolves
exactly which declarations govern this mandate's limits. The same reasoning
now closes the ambiguity itself: when two matched tools disagree on a
measure's kind, the write is refused (`measure_kind_conflict`) rather than
silently keeping the first tool's answer. A mandate whose tool patterns
cannot agree on what a limited measure counts is a mandate that should not
have been grantable as written.

### 3. A limit written before this ADR has no stored kind, and takes a documented fallback

Every row in `tools.mandates.limits` written before this change lacks `kind`.
Two ways to close that gap were on the table: a backfill migration that
re-derives `kind` for every existing row from its mandate's current tool
declarations, or a documented runtime fallback applied at read time for a row
that has none.

**Decision: a documented fallback, not a backfill.** A backfill has to solve
the exact ambiguity §2 already flags: a stored mandate may match tool
declarations that have since changed or been deleted, so "re-derive from the
current declaration" is not always well-defined for a row written against a
different tool version. A fallback is simple, correct by construction for the
overwhelmingly common case (a count is spelled as a unit name, money as a
currency code), and, this is the part that makes it acceptable rather than a
second heuristic hiding behind this ADR's name, it is the exact guess this
ADR replaces, kept as a named, single-purpose, single-location function
(`legacyMeasureKindGuess`, `packages/rules/src/mandates/measures.ts`) that
every future reader can find and remove, rather than reinvented differently
at each call site the way `isCurrencyCode` was found reinvented nowhere else
only because nobody else had needed the answer yet.

The fallback resolves in exactly one place: `withResolvedKinds`, called from
`parseMandateRow` (`packages/rules/src/mandates.ts`), the single function
every mandate row passes through before its `limits` reach any handler,
`readAuthority`, or the wire. A row written since this ADR keeps its real
`kind`; a row written before takes `legacyMeasureKindGuess(currencyOrUnit)`.
Nothing downstream of `parseMandateRow` (`readAuthority`, `mapMandates`, the
app's mapper) guesses again; each reads `kind` as a resolved fact. The app's
mapper, `toMandateDetail` in `apps/app/src/data/live/mappers/mandates.ts`,
applies the same fallback a second time for the one case `parseMandateRow`
cannot cover: a ledger row drawing a measure the mandate's *current* `limits`
no longer lists at all, because `update_mandate_limits`'s whole-record
replacement removed it while the append-only ledger kept the movement. There,
`authority.find(...)` returns no matching entry, and `legacyMeasureKindGuess`
is the same documented, single-function fallback, not a second heuristic.

The fallback is removable once every stored limit carries a real `kind`,
either by a future backfill migration or by attrition as `update_mandate_limits`
re-stamps every row it touches (§1: a `limitChanges` edit reruns
`assertToolsDeclareMeasures` on the merged record and persists its stamped
output, so touching *any* field of an old mandate's limits refreshes every
measure's `kind`, not only the one the operator changed).

### 4. `isCurrencyCode` stops deciding anything downstream of the write

`apps/app/src/data/live/mappers/mandates.ts`'s `measureValue` now takes the
resolved `kind` as a parameter and switches on it, the same shape as the
gate's `readMeasure`. It calls `isCurrencyCode` nowhere. `isCurrencyCode`'s
other use, refusing a currency-code unit on the request form in
`apps/app/src/features/mandate/actions.ts` and
`apps/app/src/features/agents/actions.ts` so a form cannot let an operator
denominate a count in the one string shape that reads as money everywhere
else, is a different rule (a write-time refusal, not a read-time
classification) and is unchanged.

## Consequences

- One fact, one place it is computed (`assertToolsDeclareMeasures`), one place
  the legacy gap is closed (`parseMandateRow`, and the mapper's ledger-only
  fallback for a measure a replacement removed), and every other reader
  takes `kind` as given. No reader of a stored mandate limit may reintroduce a
  guess from `currencyOrUnit`; a future one that finds itself tempted to is the
  signal that the fact did not reach it and the plumbing, not the reader,
  needs the fix.
- `mandateLimitSchema.kind` is optional on the wire, permanently, because a
  legacy row's stored jsonb will not carry it until it is touched or backfilled.
  A contract consumer must not treat its absence as an error; `mandateAuthoritySchema.kind`
  is the field to read when a definite answer is needed, because that one is
  always resolved before it leaves a handler.
- A mandate whose tool patterns match two tools declaring the same limited
  measure with different types is now refused at grant, request or update time
  (`measure_kind_conflict`) rather than silently taking one of the two answers.
  This is a new, stricter refusal on writes that previously succeeded only by
  accident of which matched tool the loop reached last; no existing fixture
  exercised that combination, and it is the shape this ADR exists to close.
- `legacyMeasureKindGuess` is deliberately not deleted the day a backfill
  might land, because a backfill is optional under this decision, not required
  by it: the fallback stays as documented, correct-by-construction cover for
  whatever mandate row nothing has touched yet.
