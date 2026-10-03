# get_spend

The Spend page's rollup at one level (Mission Control spec §12.7, §12.9; ADR-060). Reads `cost.daily_totals` for the active workspace over an inclusive day range, grouped by operator, agent, model, tool, task, or cost center, and answers one row per group plus the period's total over every run: the month strip. The rows are a derived index rebuilt from frames by the rollup jobs (`cost.run-progress` while a run records frames, `cost.run-rollup` after each seal, `cost.daily-rollup` nightly); nothing here reads ClickHouse. A run still open is in every figure at its running estimate, and `estimatedRuns` says how many of the period's runs that is (ADR-159).

## Mode

**sync**

## Surface

**Surfaces:** api, mcp, agent

- API: `POST /v1/:org_slug/:workspace_slug/spend`
- MCP: `get_spend`
- Agent: one of the in-app assistant's seven pins, offered on every turn (`INTERACTIVE_AGENT_CAPABILITIES`). Low risk, no approval.
- Authentication: session (org Owner, Admin, Billing or Member; workspace Owner or Member)
- Capability name: `get_spend`
- Not billed (`noBillingGate: true`): reading your own spend is never a governed action (ADR-052 exclusion 2). IAM default-deny; medium sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `period` | object | yes | `{ from, to }`, UTC days `YYYY-MM-DD`, `to` on or after `from`, at most 92 days (`SPEND_RANGE_DAYS_MAX`): one read folds at most a quarter of the workspace's runs |
| `groupBy` | enum | yes | `operator`, `agent`, `model`, `tool`, `task`, `cost_center` |

## Output

| Field | Type | Description |
|---|---|---|
| `period` | object | the range as asked |
| `groupBy` | enum | the level as asked |
| `total` | figure | the period over every run in the workspace (below) |
| `days` | object[] | one `{ day, cost, calls, runs }` per day of the period, oldest first, days with no run included with `cost: null` |
| `reported` | money or null | the part of `total.cost` the harness reported: every model whose frames were all `client_attested`; null when no such model carries a cost |
| `observed` | money or null, optional | the part of `total.cost` the gateway metered: every model whose frames were all `gateway_observed`. A `mixed` or `estimated` model counts as not observed, so the figure is a floor; null when no such model carries a cost |
| `composition` | object, optional | `{ toolDefinitionTokens, contextFrameTokens, steeringTokens, toolResultTokens }`: the standing context the period's model calls carried, summed over every call the recorder measured, and the tool-result tokens, each result counted once when it was recorded. A part no run recorded is null, never `0` |
| `estimatedRuns` | integer, optional | the period's priced runs that were still open when their row was last rebuilt; their cost is in the figures as a running estimate |
| `unmeteredRuns` | object, optional | `{ total, byHarness: [{ harness, runs }] }`: the period's wrapped runs whose rollup found no model call, by the harness that ran them, most runs first. `total.runs` counts them and `total.cost` cannot, so the Spend page prints this beside the total. See [Runs with no usage](#runs-with-no-usage) |
| `rows` | row[] | one per group; largest spend first, groups with no cost after those with one, then by key |

A figure:

| Field | Type | Description |
|---|---|---|
| `cost` | object or null | `{ micros, currency, basis }`; null when no frame in the group was priced |
| `calls` | integer | model calls on `model` rows, tool calls on `tool` rows, steps elsewhere |
| `runs` | integer | runs attributed to the group |
| `proven` | money or null | spend on runs whose verdict is `flipped`; null until a verdict lane writes one |
| `accepted` | money or null | spend on runs a human accepted; null until one is recorded |
| `productiveRatio` | number or null | 0..1, run-weighted; null until the grading lane writes it |

A row adds `key` (an operator's principal public id `prn_…`, the `operatorId` a run of `list_runs` carries and the key `get_spend_drill` takes; an agent key `org_ns.ws_ns.slug`; a model id; a tool name; a task reference; or a cost-center label, with `~none` for spend no cost center claims), `provider` (set on `model` rows) and `tokens` by class (`input_uncached`, `cache_read`, `cache_write_5m`, `cache_write_1h`, `output`, `reasoning`, `server_tool_request`). `server_tool_request` counts web search requests, which the book prices per request, so it is not a token count. A row rolled up before the class existed reads 0 for it.

A row that holds whole runs, on the `operator`, `agent`, `task` and `cost_center` levels and the assistant row of those levels, also carries `tokenSources`: `{ toolDefinitionTokens, contextFrameTokens, steeringTokens, toolResultTokens }`, the tokens the row's runs spent on each prompt source, summed (#5295). The first three are each run's `cost.run_totals` sums, the recorder's estimates over every counted call. `toolResultTokens` is each run's tools' result tokens. A source no run of the row measured is null, never zero. The `tokens` classes already count all four. A `model`, `tool` or `mcp_server` row holds part of a run, and the sources are not split by model or tool, so it carries no `tokenSources`.

The same rows carry `windows`: `{ runs, requests, requestsWithoutTokens, promptTokens, blocks: { system, steering, tools, context, conversation } }`, the request windows of the row's runs summed block by block (#5341). The rollup stores each run's window composition in `cost.run_totals.breakdown`, read from the windows the run recorded the way [`get_run_context`](run.context.get.md) reads them, and `runs` counts the runs that stored one. Each block is its byte share of the prompt total each request reported, so the blocks sum to `promptTokens`. The windows are the only record of a run's conversation and system tokens. The conversation block counts every message a request sent again, tool results included. `windows` is null when no run of the row stored a composition: a run that recorded no window, and a run rolled up before the composition was kept, are not measured, never zero. A block none of the runs carried is null.

## Basis

`basis` says who observed the money: `gateway_observed` (the `@oxagen/ai` gateway priced the call), `client_attested` (the harness reported it), `mixed` (the group holds both), `estimated` (a frame's model had no price entry, so the figure is the frame's own reported cost or the classes the book could price). A number never reads stronger than its basis, and a group with no priced frame answers `cost: null`, never `0`. Proven and accepted are never folded together (spec §12.8).

## Attribution

A run is attributed to the operator, agent and task it names; a run that names none is not on that level. The `cost_center` level is the exception: every run is on it exactly once, so its rows sum to the total. A run appears under every model its frames used and every tool it called. Tool rows carry counts and no money: no frame prices a tool call.

## The assistant row

The in-app assistant's spend is one row of its own in every grouping, keyed `~oxagen_assistant`. The other rows leave the assistant's share out, and the total, the days, and the reported spend still count it, so the rows sum to the total. The row's `topRuns` is always empty, and its `operator`, `provider`, `proven`, `accepted`, and `productiveRatio` are null. The row appears only when the period has a run of the assistant. Oxagen runs the assistant and the workspace does not monitor it, so no row lists one of its runs and the row opens no drill (ADR-235, amended 2026-10-02).

## Runs with no usage

A harness whose model calls pass through neither the Oxagen gateway nor the local proxy records tool calls and no usage. Cursor is one, and so are Stella on a provider other than Anthropic and a Stella session with its own Anthropic base URL. The rollup counts such a run and prices none of it. `unmeteredRuns` counts the period's runs whose `cost.run_totals` row holds no model call, grouped by the session's `harness`, so a reader can see what the total leaves out. An open run counts once it has made a tool call, since the rollup writes a row on a run's first batch, before its first model call can land. A run not yet rolled up has no row and is not counted. A ledger run meters every call through the gateway, so it is never counted. The count is read from Postgres, like the rest of this answer.

## Cost center

The `cost_center` level charges each run to the cost center the rollup resolved when it rolled the run up (ADR-142): the agent's label first, then the workspace's. A run with neither lands on the `~none` key, so the level's rows sum to the period's total. A label deleted from the organization's list claims no new run. Runs already rolled up keep the cost center they had. `list_cost_centers` answers the organization's labels, and `export_cost_center_statement` answers the organization-wide chargeback statement.
