# billing.action_estimate

**Domain:** billing
**Mode:** sync
**Scope:** org + workspace (Owner, Admin, Billing, Member)
**Surfaces:** api, mcp, agent
**Risk level:** low
**Capability name:** `preview_action_cost`

## Intent

The run → action calculator (spec §3.4). "Governed action" is precise and
"run" is legible, and they are not the same word — ADR-052's Consequences
section names a published calculator as part of shipping the meter rather
than a nicety: a buyer who cannot convert their own volume into a price has
been handed a rate card they cannot use.

Pure arithmetic over published constants — no organisation data, no DB read.
It shows its assumptions in the output (spec §3.4: "the calculator … shows
its assumptions"), because a conversion whose ratio is hidden is a quote a
buyer cannot check. `noBillingGate: true` — a price estimate is never itself
a charge.

## Input

| Field | Type | Notes |
|---|---|---|
| `runsPerYear` | `number` (positive int, ≤ 1,000,000,000) | Projected agent runs per year. |
| `runClass` | `"qa_lookup" \| "standard_task" \| "multi_step" \| "long_running"`, optional, default `"standard_task"` | Drives the published actions-per-run ratio (spec §3.4). |
| `actionsPerRun` | `number` (positive, ≤ 10,000), optional | Override the actions-per-run ratio directly, for a customer who has measured their own. Wins over `runClass` when both are given — a measured ratio beats a published typical one. |
| `tier` | `"free" \| "build" \| "scale" \| "enterprise"`, optional | Tier to price against. Defaults to `scale`. |

## Output

| Field | Type | Notes |
|---|---|---|
| `assumptions` | object | The ratio actually used and where it came from: `{ runsPerYear, actionsPerRun, actionsPerRunSource: "run_class" \| "caller_supplied", runClass, tier }`. |
| `actionsPerYear` | `number` | `runsPerYear × actionsPerRun`, rounded to the governed-action unit. |
| `includedActionsAnnual` | `number \| null` | Included by the tier; `null` when the tier's figure is negotiated (enterprise). |
| `overageActions` | `number` | Actions past the allowance. |
| `band` | `{ id, usdPer1000 }` | The volume band the overage prices at. |
| `overageUsd` | `number` | Overage cost for the year, in USD. |
| `excludes` | `string` | States what this estimate does NOT include — the subscription platform fee (negotiated on enterprise) and model tokens (the customer's own bill under BYOK). |

## Roles

Org: Owner, Admin, Billing, Member. Workspace: none.

## Side effects

None — pure arithmetic over published constants. No organisation data is read
beyond the `tier` the caller chose to price against.

## Errors

| code | meaning |
|---|---|
| `tenant_missing` | No active tenant on the request context. |
| `validation_error` | `runsPerYear`, `actionsPerRun`, `runClass`, or `tier` fails its bound. |

## Surfaces

- **API:** `GET /v1/:org/:workspace/billing/actions/estimate?runs_per_year&run_class&actions_per_run&tier`
- **MCP:** tool `preview_action_cost`

## SPEC references

- [ADR-052](../adr/ADR-052-governed-action-as-the-billable-unit.md) —
  Consequences (a published calculator ships with the meter)
- [`docs/specs/governed-action-metering.md`](../specs/governed-action-metering.md)
  §3.4 (run-class conversion), §4.1 (volume bands)
