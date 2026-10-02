# get_unproductive_spend

The unproductive spend of the active workspace over a day range: the one total Spend › Findings leads with (spend spec, Counting). Beside it, the figures counting rules 2 and 3 keep out of that total.

**Surfaces:** api, agent

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/spend/unproductive`
- Authentication: session (org Owner, Admin, Billing, or Member; workspace Owner or Member), the people who read [`list_findings`](finding.list.md)
- Capability name: `get_unproductive_spend`
- Not billed (`noBillingGate: true`). IAM default-deny; medium sensitivity. In an Enterprise org, migration `20261002020000_backfill_spend_ranking_grants.sql` grants the capability to the system roles of every org that existed before it did.
- Agent: Stella finds it with `search_tools` and loads it with `load_tools`. It runs with no approval step (`riskLevel: low`).

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `period` | object | yes | `{ from, to }`, UTC days, `to` on or after `from`, at most 92 days (`SPEND_RANGE_DAYS_MAX`) |

## Output

| Field | Type | Description |
|---|---|---|
| `period` | object | as asked |
| `unproductive` | money | the headline: every frame an open or applied finding of detectors 1, 7, or 8 claims in the period, counted once (rule 1) |
| `spend` | money or null | the priced spend of the frames the workspace's runs ran in the period; null when nothing was priced, when it holds another currency, or when a run that crosses the period's edge could not be priced |
| `share` | number or null | `unproductive` over `spend`, capped at 1; null when `spend` is null or zero |
| `parts` | object[] | detectors 2, 3, and 5 in that order, each `{ detector, saving, findings }` (rule 2) |
| `estimate` | object | detector 4 as `{ saving, findings }`: a counterfactual on a smaller model class (rule 3) |

`parts[].saving` and `estimate.saving` add the stored savings of the open and applied findings of the detector's kinds whose window overlaps the period. Detector 2 is `standing_context`. Detector 3 is `cache_writes_never_read`, `idle_cache_rewrites`, and `cache_busts`. Detector 5 is `unpaged_results`. Detector 4 is `model_class_fit`. None of them adds to `unproductive`.

## Errors

| Code | Reason | When |
|---|---|---|
| `conflict` | `unproductive_mixed_currency` | the period's claimed frames and findings are priced in more than one currency; each figure sums one currency, so none is built |

## Counting

The headline reads the claim rows [`get_operator_ranking`](spend.operator_ranking.md) reads (`readUnproductiveClaims`, ADR-208) and counts them the same way (`countClaims`). A frame two findings claim counts once, under the lowest detector. For one period, the ranking's total equals `unproductive`.

The share counts both sides by the time each frame ran. A run whose priced frames all fall in the period adds its whole cost. A run that crosses the period's first or last day adds only its frames inside the period, read from the frame store and priced the way the rollup prices them. At most 50 crossing runs are read, largest first. When one is left unread or cannot be priced, `spend` and `share` are null.
