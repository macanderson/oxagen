# ADR-102: A limit change merges under the mandate's row lock, and replacement stays for callers that hold the record

- **Status:** Accepted
- **Date:** 2026-09-19
- **Owners:** kernel, app
- **Related:** Mission Control spec §6.9 part 3 (Change limits); ADR-059
  (mandates, the ledger, and the consequence roles that gate a change);
  `docs/capabilities/update_mandate_limits.md`; `apps/app/ARCHITECTURE.md` §9,
  the earlier entries on one shape — a surface that can store a wider bound
  than the operator entered
- **Numbering:** 102. ADR-101 is taken by the four first-class harnesses
- **Delivered by:** `limitChanges` on `update_mandate_limits`,
  `applyLimitChanges` in `packages/handlers/src/mandate.limits.update.ts`,
  `mandateLimitChangesSchema` in `packages/oxagen/src/mandates/schemas.ts`, and
  `changeMandateLimits` in `apps/app/src/features/mandate/actions.ts`

## Context

`update_mandate_limits` **sets** `limits`. A caller that wants to change one
measure and keep the others therefore has to send every bound the mandate
holds, which means reading the mandate, merging its edit over the stored
record, and posting the whole record back.

That is what the app did. `changeMandateLimits` read the mandate through
`get_mandate`, laid the operator's edit over the stored `limits` at two depths,
and sent the result. The handler locks the row for its own write
(`lockMandate`, `SELECT … FOR UPDATE`), but nothing held a lock across the
app's read. So two operators editing one mandate at the same time both read
the same record, and both send a complete replacement: one lowers the amount
cap, the other changes the calls cap, and the second write restores the amount
cap from a snapshot taken before the first write landed. Nothing errors. The
ledger keeps reading correctly afterwards, because remaining authority is
computed against whatever limit the row now holds.

A restored bound is authority nobody granted. It is the same shape §9 of
`apps/app/ARCHITECTURE.md` records repeatedly on this lane — a surface that can
store a wider bound than the operator entered — and the review of PR #3385
counts it as the sixth finding of that class on that PR. The rule the earlier
ones settled holds here: when being wrong is not symmetric, take the side that
cannot grant more than was asked for. A bound that is wider than the operator
entered is the failure a mandate surface must not have; a bound that is
narrower is a denial someone can see.

Two fixes were available.

**A version token.** Return the mandate's `updatedAt` or a row version from
every read, require it on a write, and refuse a write whose token is stale.
It closes the race and it costs the round trip: the caller still reads, still
merges, and now also handles a refusal by reading again and redoing the merge.
Every caller has to implement the retry, and a caller that does not implement
it correctly fails closed but fails often.

**Make "change these and leave the rest" a first-class operation.** The merge
then happens where the lock already is, the caller sends only what it changed,
and there is no snapshot to be stale.

## Decision

### 1. `limitChanges` beside `limits`, and never both

`update_mandate_limits` takes `limitChanges`: a record keyed by measure name
whose values are partial bounds (`perCall`, `perPeriod`, `period`,
`currencyOrUnit`, each optional, at least one present). An absent field means
"leave what is stored", so a change cannot delete anything.

`limits` and `limitChanges` are mutually exclusive, refused together by the
contract's own `refine`. They state two different intentions for the same
field, and there is no reading of a request carrying both that is safe to
guess. Which one would win is not a question, because both is invalid.

### 2. The merge happens inside the transaction that locks the row

`applyLimitChanges(locked.limits, input.limitChanges)` runs after
`lockMandate(tx, current.id)` and before the `UPDATE`, in the same
transaction. It merges at two depths:

- every measure the change does not name keeps its bound;
- within a named measure, every field the change does not carry keeps its
  stored value — the other sublimit, the unit, and `period`, which a caller
  editing one figure has said nothing about.

A bound can be deleted at either depth, and a deleted bound is unbounded
authority for that measure, which is why both depths keep rather than replace.
The merged record is parsed by `mandateLimitsSchema` rather than asserted into
shape: a change that would leave a bound with no figure or no unit is refused
as `conflict` / `limit_incomplete` instead of stored. That is reachable only
for a measure the record does not hold yet, since a change to a stored bound
inherits both. A bound for a measure the record does not hold takes `daily` as
its window when the change names none; nothing is widened by that default,
because nothing was bounded before.

`assertToolsDeclareMeasures` runs on the merged record, so a change is refused
by the declared-measure and unit checks exactly as a replacement is.

### 3. Replacement stays, unchanged, and stays the only way to delete a bound

An API, MCP, CLI or agent caller that sends `limits` gets exactly the
semantics it always had. Replacement is the correct primitive for a caller
that holds the whole record, and it is the only way to remove a measure's
bound at all. Making the handler merge `limits` per measure would have closed
the race and taken deletion away with it.

### 4. The app sends the change and reads nothing

`changeMandateLimits` builds the change from the form and makes exactly one
kernel call. The `get_mandate` read, the refusal mapping that read needed, and
the app-side merge are gone. The promise the dialog's copy makes is unchanged
and is now kept by the handler: a blank field leaves that bound as it is, and
removing a bound altogether is a whole-record `limits` write over the API or
MCP.

## Consequences

- Two operators changing different bounds on one mandate each keep the other's
  change. Two operators changing the *same* bound still resolve last-write-
  wins, in lock order, which is what a single figure with two authors means;
  neither write restores a third bound.
- The app makes one call where it made two, and holds no snapshot.
- `limitChanges` cannot delete a bound. An operator who wants a bound gone
  uses the API or MCP with a whole `limits` record. The durable improvement
  that would let a form express the whole record is still `measures` on
  `list_tool_declarations`' output, recorded in §9's 2026-09-16 entry: without
  it the app cannot know a measure's type, unit or scale, so it cannot safely
  author a complete limits record at all.
- Two ways to write limits is a cost. It is bounded by the exclusivity rule
  and by the merge living in one function that one handler calls; a surface
  cannot pick a third behaviour.
- No version token is introduced, so nothing about mandates is optimistically
  concurrent and no caller needs a retry loop. If a future capability needs
  stale-read detection across fields the lock does not cover, that is its own
  decision and this one does not pre-empt it.
