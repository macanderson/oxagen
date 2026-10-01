# get_operator_ranking

The operators of the active workspace ranked by unproductive spend, highest first (spend spec, Operator ranking; D15). A manager reads it to see where coaching pays. Each figure is a count of claimed frames. The ranking gives no verdict on the person.

**Surfaces:** api, agent

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/spend/operators`
- Authentication: session (org Owner or Admin)
- Capability name: `get_operator_ranking`
- Not billed (`noBillingGate: true`). IAM default-deny; medium sensitivity. The handler asserts the role itself, so an org Member, a Billing member, a workspace Member, and a workspace Owner who is not an org Owner or Admin are refused with `forbidden` (`org_role_required`) on every tier. In an Enterprise org the kernel's IAM check admits the same two roles: migration `20261001120000_backfill_spend_ranking_grants.sql` grants them to every org that existed before the capability did.
- No workspace role reads the ranking. No person holds a workspace IAM role yet (#3198), so in an Enterprise org the kernel cannot admit a workspace Owner, and the ranking names org roles on every tier so that each tier admits the same people.
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

## Errors

| Code | Reason | When |
|---|---|---|
| `forbidden` | `org_role_required` | the caller is not an org Owner or Admin |
| `conflict` | `ranking_mixed_currency` | the period's claimed frames are priced in more than one currency; the ranking sums one currency, so none is built |

## Counting

The ranking reads the claim rows the headline reads (`readUnproductiveClaims`, ADR-208) and counts them the same way (`countClaims`). A frame two findings claim counts once, under the lowest detector. So the operator totals and `unattributed.unproductive` sum to `unproductive`, and each operator's run figures sum to that operator's total.

The unproductive share counts both sides by the time each frame ran. The claims reader filters on each frame's time. The spend side adds a run whose priced frames all fall in the period whole, and prices a run that crosses the period's first or last day by its frames inside the period, read from the frame store. At most 50 crossing runs are read, largest first. An operator with a crossing run left unread or unpriced gets no share.

Done work orders and the unassigned share per operator are not in the answer yet. They arrive with the work order record (F13).

## Pseudonyms

An org Owner or Admin turns pseudonyms on with [`set_operator_pseudonyms`](spend.operator_pseudonyms.set.md). A pseudonym is `Operator` and eight hex digits of an HMAC of the principal public id under a per-workspace salt, so one operator keeps one pseudonym. With the setting on, the answer carries no key, no facts, and no run ids, because a run page names its operator. It also carries no `unproductiveShare` and no `runs`. `get_spend` names each operator beside priced spend and run counts, and the share gives back an operator's priced spend, so either figure would match a pseudonym to a name. The ranks, `unproductive`, and `shareOfTotal` stay.

The setting governs this answer. A manager who also reads named findings or run pages can still add up one person's figures and compare them.
