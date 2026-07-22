# billing.budget.get

**Domain:** billing
**Mode:** sync
**Scope:** org + workspace (Owner, Admin, Billing, Member)
**Surfaces:** api, mcp, agent
**Risk level:** low
**Capability name:** `get_spend_budget`

## Intent

Read the hard **period-to-date spend ceilings** governing the active scope and their live burn. Two ceilings can apply and both are returned when configured:

- the **org-level** ceiling (`scope: "org"`) — covers cumulative spend across every workspace in the org;
- this **workspace's** own ceiling (`scope: "workspace"`).

Each carries its current burn so the Billing → Budgets panel can render a live gauge. Reading your own budget is exempt from the budget gate (`noBillingGate`), so being over budget never blocks this read.

This is a different axis from `budget.policy.*` / `workspace.budget_policy.*`, which cap a **single agent turn's** dollar cost. This caps cumulative **period** spend for a whole org or workspace and is enforced in the kernel `invoke()` admission path.

## Input

None (`{}`). Reads the caller's active org + workspace scope.

## Output

| Field | Type | Notes |
|---|---|---|
| `budgets` | `SpendBudgetStatus[]` | One entry per configured ceiling, org first then workspace. Empty when none is set. |

### `SpendBudgetStatus`

| Field | Type | Notes |
|---|---|---|
| `scope` | `"org" \| "workspace"` | Which ceiling this is. |
| `publicId` | `string \| null` | External handle for the ceiling row. |
| `enabled` | `boolean` | Whether the ceiling is enforced. |
| `period` | `"monthly" \| "rolling"` | `monthly` = calendar month to date (UTC); `rolling` = trailing `windowDays`. |
| `windowDays` | `number \| null` | Trailing window length for `rolling`; `null` for `monthly`. |
| `limitUsd` | `number \| null` | The hard ceiling in USD. |
| `spentUsd` | `number` | Period-to-date spend in USD (fresh ClickHouse read). |
| `projectedUsd` | `number` | Linear projection of spend to the period end (monthly); equals `spentUsd` for `rolling`. |
| `ratio` | `number` | `spent ÷ limit`. |
| `state` | `"ok" \| "threshold_50" \| "threshold_80" \| "threshold_95" \| "exceeded"` | Position relative to the ceiling. |
| `reachedThreshold` | `number` | Highest ladder rung reached (0/50/80/95/100). |
| `windowStart` / `windowEnd` | `string` (ISO 8601) | The measured window. |

## Roles

Org: Owner, Admin, Billing, Member. Workspace: Owner, Admin, Member.

## Side effects

None — read only. Spend is aggregated from ClickHouse `token_usage`; a degraded telemetry store yields `spentUsd = 0` rather than an error.
