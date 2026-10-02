# get_spend_per_merged_pr

What each agent in the active workspace spent per merged pull request over a day range (spend spec, detector 8, its first lever). The Spend page's Month tab shows it beside each agent's spend.

**Surfaces:** api, agent

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/spend/per-merged-pr`
- Authentication: session (anyone who may read `get_spend`)
- Capability name: `get_spend_per_merged_pr`
- Not billed (`noBillingGate: true`). IAM default-deny; medium sensitivity.
- Agent: Stella finds it with `search_tools` and loads it with `load_tools`. It runs with no approval step (`riskLevel: low`).

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `period` | object | yes | `{ from, to }`, UTC days, `to` on or after `from`, at most 92 days (`SPEND_RANGE_DAYS_MAX`) |

## Output

| Field | Type | Description |
|---|---|---|
| `period` | object | as asked |
| `agents` | object[] | one row per agent with a bounded run in the period, in key order |

Each agent:

| Field | Type | Description |
|---|---|---|
| `agentKey` | string | the agent's key (`org_ns.ws_ns.slug`), the key of its `get_spend` agent row |
| `boundedRuns` | integer | runs that started in the period and opened at least one pull request |
| `unpricedRuns` | integer | bounded runs the rollup priced nothing for; their spend is not in `spend` |
| `spend` | cost or null | the spend on the priced bounded runs; null when none was priced or the runs hold more than one currency |
| `mergedPrs` | integer | distinct pull requests those runs opened that merged and were not reverted within 14 days of the merge |
| `perMergedPr` | cost or null | `spend` over `mergedPrs`, rounded to the nearest micro; null when `absence` says why |
| `absence` | string or null | `no_merged_pr`, `mixed_currency`, or `not_priced`; null when there is a figure |
| `runs` | object[] | the costliest bounded runs, at most ten: `{ runId, startedAt, cost, pullRequests }` |

Each pull request under a run is `{ prKey, url, state }`. `state` is `merged`, `reverted` (merged, then reverted within 14 days), `closed`, `open`, or `unread` (no state read yet). Only `merged` counts.

## Counting

- **Bounded run.** Nothing in the record marks a bounded task until work orders arrive (F13). Until then, a bounded run is a run that opened a pull request: it has a `cost.run_pr_outcomes` row whose `pr_key` is not `none`.
- **Spend.** Every bounded run that started in the period adds its spend, whatever its pull requests became. The period windows runs by start, as `get_spend` does.
- **Merged.** A pull request counts once per agent, however many of the agent's runs opened it. A revert counts the way detector 8 counts it: on or after the merge, and 14 days or fewer after it. A merge less than 14 days old counts until a revert arrives. A merge or revert with no time, and a revert dated before its merge, leave the merge standing.
- **Absent, never zero.** An agent with no merged pull request has no figure.

## Errors

None beyond the kernel's own refusals.
