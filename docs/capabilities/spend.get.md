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

## Basis

`basis` says who observed the money: `gateway_observed` (the `@oxagen/ai` gateway priced the call), `client_attested` (the harness reported it), `mixed` (the group holds both), `estimated` (a frame's model had no price entry, so the figure is the frame's own reported cost or the classes the book could price). A number never reads stronger than its basis, and a group with no priced frame answers `cost: null`, never `0`. Proven and accepted are never folded together (spec §12.8).

## Attribution

A run is attributed to the operator, agent and task it names; a run that names none is not on that level. The `cost_center` level is the exception: every run is on it exactly once, so its rows sum to the total. A run appears under every model its frames used and every tool it called. Tool rows carry counts and no money: no frame prices a tool call.

## Runs with no usage

A harness whose model calls pass through neither the Oxagen gateway nor the local proxy records tool calls and no usage. Cursor is one, and so are Stella on a provider other than Anthropic and a Stella session with its own Anthropic base URL. The rollup counts such a run and prices none of it. `unmeteredRuns` counts the period's runs whose `cost.run_totals` row holds no model call, grouped by the session's `harness`, so a reader can see what the total leaves out. A run not yet rolled up has no row and is not counted. A ledger run meters every call through the gateway, so it is never counted. The count is read from Postgres, like the rest of this answer.

## Cost center

The `cost_center` level charges each run to the cost center the rollup resolved when it rolled the run up (ADR-142): the agent's label first, then the workspace's. A run with neither lands on the `~none` key, so the level's rows sum to the period's total. A label deleted from the organization's list claims no new run. Runs already rolled up keep the cost center they had. `list_cost_centers` answers the organization's labels, and `export_cost_center_statement` answers the organization-wide chargeback statement.
