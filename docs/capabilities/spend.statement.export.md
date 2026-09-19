# export_statement

The monthly spend statement for the active workspace as CSV (Mission Control spec §12.9 "Monthly statement", App. E; ADR-060). One line per group at every level (operator, agent, model, tool, task) with the month's runs, calls, cost in micros and, on that same line, the cost in cents rounded half to even once (spec §12.3: rounding to cents happens at the statement line and nowhere earlier). Every line names its basis; proven and accepted spend stay apart.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/spend/statement/export`
- MCP: `export_statement`
- Authentication: session (org Owner, Admin, Billing or Member; workspace Owner or Member)
- Capability name: `export_statement`
- Not billed (`noBillingGate: true`). IAM default-deny; medium sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `month` | string | yes | `YYYY-MM`, a UTC month |
| `format` | enum | no | `csv` (default; the one format) |

## Output

| Field | Type | Description |
|---|---|---|
| `month` | string | as asked |
| `filename` | string | `spend-statement-YYYY-MM.csv` |
| `mediaType` | literal | `text/csv` |
| `content` | string | the CSV text: a header line then one line per group, RFC 4180 quoting |
| `lines` | integer | lines after the header |

Columns: `level, key, provider, runs, calls, cost_micros, cost_cents, currency, basis, proven_micros, accepted_micros`. An unpriced group leaves `cost_micros`, `cost_cents`, `currency` and `basis` empty; a group with no verdict or acceptance leaves `proven_micros` or `accepted_micros` empty.

## What waits

A signed PDF and the export job listed on Audit › exports wait on the audit-exports lane and a signing key (ADR-060 §6); the statement is built and answered in the call.
