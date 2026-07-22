# billing.budget.set

**Domain:** billing
**Mode:** sync
**Scope:** org + workspace (Owner, Admin, Billing)
**Surfaces:** api, mcp, agent
**Risk level:** medium
**Capability name:** `set_spend_budget`

## Intent

Create or replace the hard **period-to-date spend ceiling** for one scope — the **org-level** ceiling (covers every workspace) or this **workspace's** own ceiling. Choose the window, the USD limit, and whether it is enforced.

Over-ceiling metered agent runs are **denied at `invoke()` before any provider call** with a typed `budget_exceeded` error. RAISING a ceiling here is the **org-admin override** that clears such a denial — it is IAM-gated (Owner / Admin / Billing) and audited through the kernel audit chain. Writing your own budget is exempt from the budget gate (`noBillingGate`).

## Input

| Field | Type | Notes |
|---|---|---|
| `scope` | `"org" \| "workspace"` | Which ceiling to set. `org` → `workspace_id = NULL`; `workspace` → the active workspace. |
| `enabled` | `boolean` | `false` keeps the config but stops gating. |
| `period` | `"monthly" \| "rolling"` | `monthly` = calendar month to date (UTC); `rolling` = a trailing N-day window. |
| `windowDays` | `number \| null?` | Required (`> 0`) for `rolling`; must be omitted for `monthly`. |
| `limitUsd` | `number` | The hard ceiling in USD (`> 0`). |

The rolling/monthly ↔ `windowDays` rule is enforced by the contract and mirrored by a DB CHECK.

## Output

The saved ceiling with its live burn — the same `SpendBudgetStatus` shape `billing.budget.get` returns per scope.

## Roles

Org: Owner, Admin, Billing. Workspace: Owner, Admin. Setting a ceiling is org governance — no Member/Viewer.

## Side effects

- Postgres: upserts one row in `billing.spend_budgets` (RLS `workspace_nullable`); records the acting user on the audit columns; resets the threshold-notification watermark so a raised ceiling re-notifies from a clean slate.
- Kernel: drops the gate's short-TTL config + spend cache for the org so the new ceiling takes effect immediately in-process.
- Audit: the kernel audit chain records the write, explaining an override.
