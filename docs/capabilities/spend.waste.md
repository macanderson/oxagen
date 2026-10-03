# list_waste

**Surfaces:** api, mcp, agent

Spend the frames show bought nothing, by cause, with the runs that prove it (Mission Control spec §12.8; ADR-060, ADR-208). Each cause is a pattern the record of the active workspace shows, never a guess. One cause is read off the `cost.run_totals` rows. The others are the frames open findings claim in `cost.finding_claims`, and they add up to the unproductive spend headline, [`get_unproductive_spend`](spend.unproductive.md), for the same period.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/spend/waste`
- MCP: `list_waste`
- Authentication: session (org Owner, Admin, Billing or Member; workspace Owner or Member)
- Capability name: `list_waste`
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
| `wasted` | cost or null | the total across causes with its basis; null when no run showed waste. It equals the unproductive spend headline for the period plus the `cache_write_never_read` cause |
| `share` | number or null | wasted over the priced spend of the runs that started in the period, the figure the Spend tile prints, capped at 1; null when either is unpriced |
| `runsWithWaste` | integer | runs that show at least one cause |
| `largestCause` | enum or null | the cause with the most money on it |
| `causes` | object[] | largest waste first, each `{ cause, wasted, runs, runIds, provingRuns }`; `runIds` are the runs that prove it, largest waste first, at most ten |
| `causes[].provingRuns` | object[] | the same runs in the same order as `{ runId, name }`. `name` is the session name the Fleet board shows, or null when the run has none |
| `findingsOutsidePeriod` | integer | the open findings of detectors 1, 7, and 8 whose frames all ran outside the period: each claims frames only outside it, or claims none and its own window lies wholly outside it. Spend › Findings lists them, and no cause counts their frames |

## Causes

| Cause | Pattern | Money |
|---|---|---|
| `cache_write_never_read` | a run that started in the period wrote prompt-cache tokens (`cache_write_5m` or `cache_write_1h` above zero) and read none back (`cache_read` at zero) | the run's cache-write cost by class from the rollup's per-model split |
| `spin_loops` | a request that repeated one call 20 or more times in a row with the same result (detector 1, `spin_loops` findings) | the claimed frames' cost |
| `retry_loops` | a request that only retried a call that had already failed with the same error (detector 1, `retry_loops` findings) | the claimed frames' cost |
| `repeated_calls` | a request whose every tool call or shell command repeated an earlier one in the run with the same input and result (detector 1, `duplicate_tool_calls` and `repeated_shell_commands` findings) | the claimed frames' cost |
| `recurring_runs` | every model call of a scheduled run that changed nothing (detector 7) | the claimed frames' cost |
| `spend_with_no_outcome` | every model call of a run whose work did not land (detector 8) | the claimed frames' cost |

The five claimed causes read the frames that open and applied findings claim and that ran in the period (`frame_at`), the rows the unproductive spend headline reads. A frame two findings claim counts once, under the lowest detector and then the first cause in the table, so the five sum to that headline. The cache-write cause reads the runs that started in the period. A run with a claimed frame in the period is not cited under it: the claim counts each of those frames whole, cache write included. The in-app assistant's runs are cited under no cause (ADR-235).

A run whose basis is `estimated` carries one reported figure with no split by class, so it is not cited under the cache-write cause; a book that prices cache writes at nothing wasted nothing, and that run is not cited either. A pattern priced against a counterfactual over the runs it cites, such as standing context or context carry, is a finding listed by [`list_findings`](finding.list.md) with its evidence and fix (ADR-062), and no cause here.

## Errors

| Code | Reason | When |
|---|---|---|
| `conflict` | `waste_mixed_currency` | the period's causes are priced in more than one currency; the total sums one currency, so none is built |
