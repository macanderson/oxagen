# get_operator_ranking

The operators of the active workspace ranked by unproductive spend, highest first (spend spec, Operator ranking; D15). A manager reads it to see where coaching pays. Each figure is a count of claimed frames. The ranking gives no verdict on the person.

**Surfaces:** api, agent

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/spend/operators`
- Authentication: session (org Owner or Admin, or the workspace's Owner)
- Capability name: `get_operator_ranking`
- Not billed (`noBillingGate: true`). IAM default-deny; medium sensitivity. The handler asserts the role itself, so an org Member, a Billing member, a workspace Member, and a workspace Viewer are refused with `forbidden` (`org_role_required`) on every tier. In an Enterprise org the kernel's IAM check admits the same three roles. Migration `20261002045000_backfill_spend_ranking_grants.sql` grants the two org roles to every org that existed before the capability did, and `20261002170000_backfill_workspace_owner_assignments.sql` grants the workspace Owner.
- The workspace Owner reads the ranking of that one workspace. The person who creates a workspace holds its Owner role in IAM (#5182). Owner of one workspace gives no access to the ranking of another.
- Agent: Stella finds it with `search_tools` and loads it with `load_tools`. It runs with no approval step (`riskLevel: low`).

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `period` | object | yes | `{ from, to }`, UTC days, `to` on or after `from`, at most 92 days (`SPEND_RANGE_DAYS_MAX`) |

## Output

| Field | Type | Description |
|---|---|---|
| `period` | object | as asked |
| `pseudonyms` | boolean | true when the workspace's pseudonym setting is on and each row carries a pseudonym |
| `unproductive` | money | the headline: every frame an open or applied finding claims in the period, counted once. [`get_unproductive_spend`](spend.unproductive.md) answers the same figure for the same period |
| `unattributed` | object | `{ unproductive, runs }` for the claimed frames whose run names no operator |
| `operators` | object[] | one row per operator, largest unproductive spend first |

Each row:

| Field | Type | Description |
|---|---|---|
| `rank` | integer | 1 for the largest |
| `operator` | object | `{ kind: "named", key, facts }` with the principal public id and the name, email, avatar, and role the directory holds; or `{ kind: "pseudonym", pseudonym }` |
| `unproductive` | money | the frames counted under this operator's runs |
| `shareOfTotal` | number | `unproductive` over the headline |
| `unproductiveShare` | number or null | `unproductive` over the priced spend of the frames the operator's runs ran in the period, capped at 1; null when none of it is priced, when that spend holds another currency, when a run that crosses the period's edge could not be priced, or when pseudonyms are on |
| `runs` | integer or null | runs with at least one counted frame; null when pseudonyms are on |
| `topRuns` | object[] | `{ runId, unproductive }`, largest first, at most ten; empty when pseudonyms are on |
| `doneWorkOrders` | integer | work orders the operator sent whose first passing check run of their definition of done fell in the period; shown when pseudonyms are on too |
| `topDoneWorkOrders` | object[] | `{ workOrderId, doneAt, runs }` for those work orders, oldest pass first, at most ten; empty when pseudonyms are on |
| `unassignedShare` | number or null | the operator's unassigned spend over the operator's spend, both by frame time; null when nothing was priced, when a run could not be priced, when the spend holds another currency, or when pseudonyms are on |
| `topUnassignedRuns` | object[] | `{ runId, unassigned }`, largest unassigned part first, at most ten; empty when pseudonyms are on |

## Errors

| Code | Reason | When |
|---|---|---|
| `forbidden` | `org_role_required` | the caller is not an org Owner, an org Admin, or this workspace's Owner |
| `conflict` | `ranking_mixed_currency` | the period's claimed frames are priced in more than one currency; the ranking sums one currency, so none is built |

## Counting

The ranking reads the claim rows the headline reads (`readUnproductiveClaims`, ADR-208) and counts them the same way (`countClaims`). A frame two findings claim counts once, under the lowest detector. So the operator totals and `unattributed.unproductive` sum to `unproductive`, and each operator's run figures sum to that operator's total.

The unproductive share counts both sides by the time each frame ran. The claims reader filters on each frame's time. The spend side adds a run whose priced frames all fall in the period whole, and prices a run that crosses the period's first or last day by its frames inside the period, read from the frame store. At most 50 crossing runs are read, largest first. An operator with a crossing run left unread or unpriced gets no share.

A work order is done at its first passing check run of its definition of done, and counts in the period that check fell in. A person's later rejection does not undo it: it counts toward the reopen rate [`get_work_order_metrics`](spend.work_order_metrics.md) reports.

Unassigned spend is spend on runs whose direct work order has no work item. A direct work order attached to a work item within 24 hours of its first run counts as assigned from that run, and one attached later counts as assigned from the attachment on. The share counts both sides by frame time, as the unproductive share does. Unassigned spend is never part of `unproductive`, so the headline and every operator total are the same with or without it.

The ranking lists only operators with unproductive spend in the period. An operator with done work orders and no claimed frame has no row, so the done column is not a count for the whole workspace. [`get_work_order_metrics`](spend.work_order_metrics.md) reports every operator.

## Pseudonyms

An org Owner or Admin turns pseudonyms on with [`set_operator_pseudonyms`](spend.operator_pseudonyms.set.md). A pseudonym is `Operator` and eight hex digits of an HMAC of the principal public id under a per-workspace salt, so one operator keeps one pseudonym. With the setting on, the answer carries no key, no facts, and no run ids, because a run page names its operator. It also carries no `unproductiveShare`, no `unassignedShare`, and no `runs`, and it cites no work orders. `get_spend` names each operator beside priced spend and run counts, and the share gives back an operator's priced spend, so either figure would match a pseudonym to a name. The ranks, `unproductive`, `shareOfTotal`, and `doneWorkOrders` stay.

The setting governs this answer. A manager who also reads named findings or run pages can still add up one person's figures and compare them.
