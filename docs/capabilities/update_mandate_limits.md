# update_mandate_limits

**Domain:** mandate
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent (requires approval)
**Sensitivity:** high
**Metering:** none (`noBillingGate`)

## Intent

Change limits on an active mandate: the limits, the targets, the mandate's
own approval rule and the validity end. Omitted fields are unchanged. The
ledger keeps its rows; the next reservation and every read take the new
`perPeriod` as the ceiling over what the period has already drawn, so a
ceiling lowered under what is drawn reads as `0` remaining until the period
rolls. A limit or target over a
measure a matched tool does not declare is refused as `grant_mandate`
refuses it.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `mandateId` | `string` | `mnd_…` |
| `limits` | `MandateLimits?` | Replaces the limits as a whole. The only way to delete a measure's bound. Mutually exclusive with `limitChanges`. `kind` is never taken from this field: the handler re-derives every measure's `kind` from the current tool declarations and persists that, not the caller's (ADR-108). |
| `limitChanges` | `MandateLimitChanges?` | Change these measures, leave the rest. Measure → a partial bound (`perCall`, `perPeriod`, `period`, `currencyOrUnit`, each optional, at least one present). Mutually exclusive with `limits`. |
| `targets` | `MandateTargets?` | Replaces the targets as a whole. |
| `approval` | `MandateApproval?` | Replaces the approval rule. |
| `validTo` | `string?` | ISO instant after `validFrom`. |

At least one field is named, and `limits` and `limitChanges` are never sent
together: they state two intentions for one field, so both is invalid rather
than one of them winning.

## Atomicity

`limitChanges` is merged over the stored record **inside the transaction that
locks the mandate row** (`lockMandate`, `SELECT … FOR UPDATE`), at two depths:
a measure the change does not name keeps its bound, and within a named measure
a field the change does not carry keeps its stored value, `period` included
(ADR-102). So two operators changing different bounds on one mandate each keep
the other's change.

Merging outside the handler is not safe, which is why this input exists. A
caller that reads the mandate, lays its edit over the stored `limits` and posts
the whole record back holds a snapshot nothing locked: one request lowers an
amount cap while another changes a calls cap, and the second write restores the
old, wider amount cap. A restored bound is authority nobody granted.

The merged record is validated as a whole, so a change that would leave a bound
with no figure or no unit is refused (`limit_incomplete`) rather than stored.
That is reachable only for a measure the record does not hold yet; a bound for a
new measure takes `daily` as its window when the change names none.

A change that renames a measure's `period` while that measure still has reserved
or settled authority in the current window is refused (`period_drawn`). Ledger
rows keep the `periodKey` they were filed under; `readAuthority` and `reserve`
derive the key from the limit's period alone, so a monthly-to-daily rename would
hide the draw and grant the ceiling again. Changing the figure inside the same
window still binds what is already drawn.

`limits` replacement keeps exactly the semantics it always had, for the same
reason: a caller that holds the whole record is stating the whole record, and
it is the only way to delete a bound.

Every write here, a `limits` replacement or a `limitChanges` merge, re-runs
`assertToolsDeclareMeasures` on the resulting record to validate it (unit,
declared-measure and matched-tool-agreement checks run over the whole merged
record regardless of which field changed), but only a measure the caller
actually names in `limits` or `limitChanges` has its `kind` re-derived from
the tool's current declaration (ADR-108 §4). A measure this call does not
name keeps its stored `kind` exactly as it was, whether that came from an
earlier real stamp or `legacyMeasureKindGuess`'s fallback. A request that
changes only `validTo`, `targets` or `approval` therefore never touches any
measure's `kind`: it does not clear a `measure_kind_changed` refusal the gate
has already started giving that mandate, and it cannot silently flip a
measure between money and a count. A legacy measure (one whose stored `kind`
was never a real stamp) is the one exception: refreshing it on any write is
the same attrition ADR-108 §3 already documents, not a change to a fact
anyone relied on. A `kind` change on a measure the operator does name is
itself refused (`measure_kind_drawn`) while the ledger still holds a
reservation or a movement drawn in the current window under the old kind,
the same as a period rename is refused while a draw would go invisible under
the new key.

**Send only the fields you changed.** The merge applies every field a change
carries, because that is the only reading a change has: it cannot tell an edit
from a value echoed back unchanged. A caller that fills a form or a payload from
a record it read, then submits all of it, restores whatever another caller
narrowed in between, through this locked path rather than around it. A sparse
change is what makes the lock worth having (ADR-102, amendment of 2026-09-19).

## Output

The mandate.

## App surface

The Change limits dialog in the mandate page's header,
`/{org}/{ws}/mandates/{mandate}`. It sends `limitChanges` and makes exactly one
call: the merge is the handler's, under the lock. A field left blank in the
dialog therefore leaves that measure's bound as it is; removing a limit
altogether means sending a whole `limits` record without it, which is this
capability over the API or MCP.

The dialog prefills the bound the mandate holds, and carries each prefill back in
a hidden field so the action can tell an edit from an untouched prefill. A field
the operator did not change is left out of `limitChanges`, and a submission that
changed only the validity window sends no `limitChanges` at all.

The dialog writes counts only and stores each figure exactly as typed: whether a
measure is money is a property of the tool version's declaration, which no read
answers, so a money limit is changed over the API or MCP by a caller that holds
the declaration.

## Roles

The consequence roles of every tag on the mandate, as `grant_mandate`.

## Side effects

- Postgres: update `tools.mandates`.
- Security event `mandate.limits_changed`.

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `org_role_required`, `no_role_covers_all_tags`, `no_principal` | Not an accountable role for every tag. |
| `not_found` | `mandate_not_found` | Not in this workspace. |
| `conflict` | `mandate_ended` | Only an active mandate changes. |
| `conflict` | `validity_inverted` | `validTo` at or before `validFrom`. |
| `conflict` | `no_tool_matches`, `measure_not_declared`, `measure_unit_mismatch`, `measure_kind_conflict` | Denied by construction, the same checks `grant_mandate` runs, against the merged record, including that matched tools agree on what a limited measure counts (ADR-108). |
| `conflict` | `limit_incomplete` | A change would leave a bound with no figure or no unit. |
| `conflict` | `period_drawn` | A measure's period cannot change while that measure still has reserved or settled authority in the current window. Ledger rows keep the old `periodKey`; renaming the window would hide the draw from `readAuthority` and `reserve`. |
| `conflict` | `measure_kind_drawn` | A measure's `kind` cannot change while that measure still has authority drawn in the current window or an open reservation under it (ADR-108 §4). `readAuthority` sums a period's rows regardless of which kind they were stamped under; letting an old-kind row sum with a new-kind reservation would corrupt the remaining figure. |
| `conflict` | `agent_retired` | The mandate's agent is retired (`status: archived`): its principal is suspended and can never draw on a widened limit (ADR-106). In practice `retire_agent` already revoked this mandate, so `mandate_ended` is the more common refusal; this covers an agent archived by another path while a mandate stayed live. |

## SPEC references

- §6.9 part 3 (Change limits), App. E; ADR-059; ADR-102 (`limitChanges` merges
  under the row lock); ADR-108 (the measure kind is stamped and re-derived on
  every write)
