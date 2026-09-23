# get_auto_eligibility

**Domain:** approval_rule
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Sensitivity:** medium
**Metering:** none (`noBillingGate`, a console read)

## Intent

What the workspace's auto-approval clause said about one approval request,
where the request stands, and who resolved it. The read behind the eligibility line on an approval
card and the receipt's Authority group.

The evaluation is read, never recomputed: it is what was recorded on the row
when the call was parked, so the page shows the decision that was actually
made rather than what today's rules would say about it. A rule edited since
is a different rule from the one that judged this call.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `approvalId` | `string` | The public id (`apr_…`) or the row uuid. |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `approvalId` | `string` | Echoes the id in the form the caller sent. |
| `state` | `"pending" \| "approved" \| "denied" \| "expired"` | Where the request stands. `pending` only while it has no resolution and its expiry has not passed. |
| `resolvedBy` | `string \| null` | `policy:<rule id>` when a rule resolved it and no person looked, `user:<usr_…>` when somebody answered, null while it waits and on a request that expired. |
| `resolvedByName` | `string \| null` | The display name of the person `resolvedBy` names. Null for a rule, for nobody, or for an account with no display name. |
| `eligibility` | `object \| null` | Null when no rule covered the call. |

`eligibility` is `{ ruleId, ok, reasons, floor }`. `reasons` is empty when
`ok`; otherwise each entry is a code, or a code and the measure it is about
(`measure_above_ceiling:amount`), and the app maps a code to its copy.
`floor` is true when at least one reason is a floor no rule can lift:
`tool_not_declared`, `tainted_input`, `critical_hazard`,
`irreversible_consequence`.

`state` is read from the row's resolution and expiry, never from
`resolvedBy` (#3521). Revoking a mandate, or its expiry, sets the resolution
of each call it parked to `expired` with no resolver, and a request whose
expiry has passed is closed before any sweep writes that. `resolve_approval`
refuses both as `approval_expired`, so a reader that took a null `resolvedBy`
as "still waiting" would offer a decision the handler refuses.

`ok` is the evaluator's verdict, not whether the call was released. A row a
mandate parked can carry `ok: true` and still be waiting for a person: a
mandate's own approval rule outranks any workspace rule (§6.9 part 3).

## App

The `app` layer is the approval card's eligibility line, drawn on the Fleet
approvals panel and on the Run page's Approvals tab, and a second read the
decide dialog makes when it opens
(`apps/app/src/features/fleet/actions.ts` → `kernelRead`). The card's own line
is as old as the page render, and a rule can release the call or another
operator can answer it between the render and the click, so the dialog reads
the row again. When `state` is anything but `pending` it holds both decision
buttons and says who resolved the call, by name with the public id beside it
for a person, by rule id for a rule, or that the call expired with no resolver,
rather than sending a decision the handler would refuse after the operator had
written a reason. The second read is the same recorded evaluation, never a
recomputed one.

A refused or unavailable re-read does not block the decision: the dialog says
the recorded line is what the page read and leaves it standing.

## Readers

An org Owner, Admin or Member — the same readers as the approvals list the
line is rendered on.

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `no_principal` | No signed-in user on the request. |
| `forbidden` | `org_role_required` | The caller is not a member of the org. |
| `not_found` | `approval_not_found` | No such approval request in this workspace. |

## SPEC references

- §6.9 part 2 (the receipt says plainly that no person looked), §6.10 (the
  Authority group), App. A.6 `control.approvals.resolved_by`; ADR-070
