# get_spend_drill

One operator, agent or tool over a trailing window: the Spend drill page (Mission Control spec §12.9; ADR-060). Reads the `cost.run_totals` rows the key attributes to in the active workspace and answers the daily series, the averages per call and per run, the key's share of the workspace's spend over the window, the tokens by class with their cache hit rate, the standing context the calls carried, the tools those runs called, and the key's figure split by agent, operator and model.

## Mode

**sync**

## Surface

**Surfaces:** api, mcp, agent

- API: `POST /v1/:org_slug/:workspace_slug/spend/drill`
- MCP: `get_spend_drill`
- Agent: the in-app assistant finds it with `search_tools` and loads it with `load_tools`. Low risk, no approval.
- Authentication: session (org Owner, Admin, Billing or Member; workspace Owner or Member)
- Capability name: `get_spend_drill`
- Not billed (`noBillingGate: true`). IAM default-deny; medium sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `kind` | enum | yes | `operator`, `agent`, `tool` |
| `key` | string | yes | for `operator`, the principal's public id `prn_…` (the `operatorId` of `list_runs`, the `key` of a `get_spend` operator row; any other string is `invalid_input`); for `agent`, the agent key; for `tool`, the tool name; 1-256 characters |
| `days` | integer | no | 1-92 (`DRILL_DAYS_MAX`, the same quarter `SPEND_RANGE_DAYS_MAX` caps `get_spend` at), default 30; the window ends today (UTC) |

## Output

| Field | Type | Description |
|---|---|---|
| `kind`, `key` | | as asked |
| `period` | object | `{ from, to }`, the window's UTC days |
| `total` | figure | the key's runs over the window (the `get_spend` figure shape). On a tool drill, `calls` counts the tool's own calls and `cost` is its results' estimate (see [A tool's spend](#a-tools-spend)) |
| `series` | object[] | one `{ day, cost, calls, runs }` per day, oldest first, days with no run included with `cost: null` |
| `averages.perCall` | money or null | cost ÷ calls, half-even; null without cost or calls |
| `averages.perRun` | money or null | cost ÷ runs, half-even; null without cost or runs |
| `share` | number or null | the key's priced spend over the workspace's priced spend in the window; null when either is unpriced, and always null on a tool drill |
| `tokens` | object | the key's runs' tokens by class (the `get_spend` token shape). On a tool drill, the tokens of the runs that called the tool, which the tool does not own |
| `cacheHitRate` | number or null | `cache_read ÷ (input_uncached + cache_read)` over `tokens`, token-weighted: the ratio the Spend page's Tokens tile prints. Null when the runs read no input token |
| `modelCalls` | integer | the model calls the key's runs made; `total.calls` counts tool calls too |
| `observed` | money or null | the part of `total.cost` the gateway metered: every model whose frames were all `gateway_observed`. A `mixed` or `estimated` model counts as not observed, so the figure is a floor. Null when no such model carries a cost, and always null on a tool drill |
| `standing` | object | `{ toolDefinitionTokens, contextFrameTokens, steeringTokens }`: the standing context the key's model calls carried, summed over every call the recorder measured. A source no run measured is null, never `0` |
| `resultTokens` | integer or null | the tool-result tokens the key's runs recorded: the tool's own on a tool drill, every tool's on another; null when no call recorded any |
| `byTool` | object[] | `{ name, calls, runs, resultTokens, cost }`, most calls first. `cost` is the tool's result tokens at each run's uncached input rate, with the `estimated` basis; null when no run priced them |
| `byAgent`, `byOperator`, `byModel` | object[] | the key's figure split by the agent its runs ran as, the operator who ran them, and the model their calls used, costliest first: `{ key, provider, operator, runs, calls, cost, tokens, resultTokens }`. `provider` is set on a model row, `operator` (the person, as `get_spend` names one) on an operator row, and `resultTokens` on a tool drill's rows. A run with no agent or no operator is in no row of that cut. A tool drill has no model rows, since its money is no model's |
| `unmeteredRuns` | object, optional | `{ total, byHarness: [{ harness, runs }] }`: the key's wrapped runs in the window whose rollup found no model call, by harness, the same count `get_spend` answers for the workspace. Absent on a tool drill, whose money is an estimate of input its runs already paid |

## The in-app assistant

A drill leaves the in-app assistant's runs out, so it matches its row on `get_spend`, which carries the assistant's spend in a row of its own. The share's divisor keeps them, because it is the workspace's whole spend, the figure the `get_spend` total shows. The assistant's row opens no drill, and a drill on its key finds no run (ADR-235, amended 2026-10-02).

## A tool's spend

No frame prices a tool call. A tool drill counts that tool's own calls on each run, and its money is what the tool's results cost as input to the calls that read them: each run's result tokens for the tool at that run's uncached input rate (ADR-199), the estimate the rollup stores per tool. The runs already paid that input, so the figure is a part of their cost and never money on top of it. It carries the `estimated` basis, and `proven`, `accepted`, `observed` and the share stay null. A run whose tool calls recorded no result tokens, or whose input has no price, adds nothing, so a tool drill with no priced result answers `cost: null`.

## Honesty

Every priced figure carries its basis, and a figure no run recorded is null, never `0`.
