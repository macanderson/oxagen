# export_cost_center_statement

The organization's monthly chargeback statement as CSV (ADR-142). The statement has one line per cost center and one line for spend no cost center claims. Each line lists the run ids that make it up, so a finance reader can open every run behind a figure. A cost center spans workspaces, so the statement reads the month's `cost.run_totals` rows from every workspace in the organization.

## Mode

**sync**

## Surface

**Surfaces:** api, mcp

- API: `POST /v1/:org_slug/:workspace_slug/spend/cost-center-statement/export`
- MCP: `export_cost_center_statement`
- Authentication: session (org Owner, Admin, or Billing). The handler asserts the org role itself (INV-29).
- Capability name: `export_cost_center_statement`
- Organization-level (`scoped: false`). The workspace in the path only routes the call.
- Not billed (`noBillingGate: true`). IAM default-deny, medium sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `month` | string | yes | `YYYY-MM`, a UTC month |
| `format` | enum | no | `csv` (default and the only format) |

## Output

| Field | Type | Description |
|---|---|---|
| `month` | string | as asked |
| `filename` | string | `cost-center-statement-YYYY-MM.csv` |
| `mediaType` | literal | `text/csv` |
| `content` | string | the CSV text: a header, one `cost_center` line per center, then one `total` line |
| `lines` | line[] | the lines as data, largest cost first, unpriced lines after priced ones, and the `~none` line last |
| `total` | object | `{ runs, unpricedRuns, cost }` over every run in the month |

A line:

| Field | Type | Description |
|---|---|---|
| `costCenter` | string | the label, or `~none` for spend no cost center claims |
| `runs` | integer | runs charged to the line |
| `unpricedRuns` | integer | runs on the line that no frame priced |
| `cost` | object or null | `{ micros, currency, basis }`, null when no run on the line was priced |
| `runIds` | string[] | the oldest 100 runs on the line, oldest first |
| `runIdsOmitted` | integer | runs on the line that `runIds` leaves out |

Columns: `line, cost_center, runs, unpriced_runs, cost_micros, cost_cents, currency, basis, run_ids`. The `run_ids` field holds every run id on the line, separated by spaces. The `lines` data lists at most 100 per line so a busy month does not carry every id twice. The CSV is the complete record. The `total` line leaves `cost_center` and `run_ids` empty, because every run is on a line above it.

The handler reads the month's run rows in pages of 5,000, oldest first by start time and run id, and selects only the columns the statement uses.

## Reconciliation

Every run lands on exactly one line at its full cost, the `~none` line included. The lines' micros therefore sum to the total's micros. Cents are rounded half to even once per line (spec §12.3), and the total's cents are rounded once from the total's micros. The line cents can differ from the total cents by that rounding, so micros are the figure that reconciles. An unpriced run is counted and listed on its line and adds nothing to its cost.

A statement figure sums micros in one currency. When a line or the total holds priced runs in two currencies, the handler refuses the statement with `conflict` and reason `statement_mixed_currency`, and the message names both currencies. An unpriced run's currency is not checked, because it adds no figure.

The `cost_center` level of `get_spend` and `export_statement` answers one workspace's share of these lines. Summed over every workspace for the same month, it gives the same runs and micros per cost center.
