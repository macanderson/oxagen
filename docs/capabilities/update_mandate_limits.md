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
| `limits` | `MandateLimits?` | Replaces the limits as a whole. The only way to delete a measure's bound. Mutually exclusive with `limitChanges`. |
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

`limits` replacement keeps exactly the semantics it always had, for the same
reason: a caller that holds the whole record is stating the whole record, and
it is the only way to delete a bound.

## Output

The mandate.

## App surface

The Change limits dialog in the mandate page's header,
`/{org}/{ws}/mandates/{mandate}`. It sends `limitChanges` and makes exactly one
call: the merge is the handler's, under the lock. A field left blank in the
dialog therefore leaves that measure's bound as it is; removing a limit
altogether means sending a whole `limits` record without it, which is this
capability over the API or MCP.

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
| `conflict` | `no_tool_matches`, `measure_not_declared`, `measure_unit_mismatch` | Denied by construction, the same checks `grant_mandate` runs, against the merged record. |
| `conflict` | `limit_incomplete` | A change would leave a bound with no figure or no unit. |

## SPEC references

- §6.9 part 3 (Change limits), App. E; ADR-059; ADR-102 (`limitChanges` merges
  under the row lock)
