# export_statement

The monthly spend statement for the active workspace as CSV (Mission Control spec §12.9 "Monthly statement", App. E; ADR-060). One line per group at every level (operator, agent, model, tool, task, cost center) with the month's runs, calls, cost in micros and, on that same line, the cost in cents rounded half to even once (spec §12.3: rounding to cents happens at the statement line and nowhere earlier). Every line names its basis; proven and accepted spend stay apart. With `rows: runs`, the file has one line per run instead, with its agent, operator, work item, and cost (see Run lines below).

## Mode

**sync**

## Surface

**Surfaces:** api, mcp, agent

- API: `POST /v1/:org_slug/:workspace_slug/spend/statement/export`
- MCP: `export_statement`
- Authentication: session (org Owner, Admin, Billing or Member; workspace Owner or Member)
- Capability name: `export_statement`
- Not billed (`noBillingGate: true`). IAM default-deny; medium sensitivity.
- Agent: Stella finds it with `search_tools` and loads it with `load_tools`. It runs with no approval step (`riskLevel: low`).

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `month` | string | yes | `YYYY-MM`, a UTC month |
| `format` | enum | no | `csv` (default; the one format) |
| `rows` | enum | no | `groups` (default) for the statement, or `runs` for one line per run |

## Output

| Field | Type | Description |
|---|---|---|
| `month` | string | as asked |
| `filename` | string | `spend-statement-YYYY-MM.csv`, or `spend-runs-YYYY-MM.csv` for `rows: runs` |
| `mediaType` | literal | `text/csv` |
| `content` | string | the CSV text: a header line, then one line per group or per run, RFC 4180 quoting |
| `lines` | integer | lines after the header |

Columns: `level, key, provider, runs, calls, cost_micros, cost_cents, currency, basis, proven_micros, accepted_micros`. An unpriced group leaves `cost_micros`, `cost_cents`, `currency` and `basis` empty; a group with no verdict or acceptance leaves `proven_micros` or `accepted_micros` empty.

## Cost center level

The `cost_center` lines key each run by the cost center the rollup resolved for it (ADR-142). A run with no cost center lands on the `~none` key, so the level's lines sum to the workspace's total for the month. For the organization-wide chargeback statement, with the run ids behind each line, call `export_cost_center_statement`.

## Run lines

With `rows: runs`, the file has one line for each run that started in the month, oldest first. This is the Spend page's Export CSV in the design (#2962).

Columns: `line, run_id, started_at, sealed_at, agent, operator_key, operator, work_item, work_item_title, runs, cost_micros, cost_cents, currency, basis`.

- `line` is `run` for a run.
- `sealed_at` is empty while the run is still open. An open run's cost is a running estimate that grows until the run seals.
- `operator` is the person's name. It is empty when no user record names the operator. The key is never printed in its place.
- `work_item` and `work_item_title` are the number and title of the work item the run served. A send names its work item. A run with no work order, or a direct work order nobody has attached to a work item, leaves both empty.
- A run no frame priced leaves `cost_micros`, `cost_cents`, `currency`, and `basis` empty, never 0.
- The cost is rounded to cents once, half to even, on its own line.
- A title or name that starts with `=`, `+`, `-`, `@`, a tab, or a carriage return gets a leading `'`, so a spreadsheet shows it as text and does not run it as a formula.

The in-app assistant's runs share one line, with `line` set to `assistant`, `runs` set to their count, and their summed cost. That line names no run, agent, operator, or work item (ADR-235). So the `cost_micros` of every line add up to the month's total.

## What waits

A signed PDF and the export job listed on Audit › exports wait on the audit-exports lane and a signing key (ADR-060 §6); the statement is built and answered in the call.
