# get_spend_drill

One operator, agent or tool over a trailing window: the Spend drill page (Mission Control spec §12.9; ADR-060). Reads the `cost.run_totals` rows the key attributes to in the active workspace and answers the daily series, the averages per call and per run, the key's share of the workspace's spend over the window, and the tools those runs called.

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
| `total` | figure | the key's runs over the window (the `get_spend` figure shape) |
| `series` | object[] | one `{ day, cost, calls, runs }` per day, oldest first, days with no run included with `cost: null` |
| `averages.perCall` | money or null | cost ÷ calls, half-even; null without cost or calls |
| `averages.perRun` | money or null | cost ÷ runs, half-even; null without cost or runs |
| `share` | number or null | the key's priced spend over the workspace's priced spend in the window; null when either is unpriced |
| `byTool` | object[] | `{ name, calls, runs }`, most calls first |

## Honesty

A tool drill counts that tool's own calls on each run and carries no money: `cost`, `proven`, `accepted`, the averages and the share are null, since no frame prices a tool call and a share of the run would be a guess. Every priced figure carries its basis.
