# billing.evidence_retention

**Domain:** billing
**Mode:** sync
**Scope:** org + workspace (Owner, Admin, Billing)
**Surfaces:** api, mcp, agent
**Risk level:** low
**Capability name:** `get_evidence_retention`

## Intent

The second meter (ADR-052 §4.3): how long this organisation's evidence is
held, whether it has opted into paying for anything beyond the included
twelve months, and what that costs.

Evidence is the asset, and holding it is the only cost of Oxagen's that
compounds — it grows with time held, not with tokens spent. Under spec §7.4
extended retention is **opt-in**, so this capability's most important field
is the one that says whether it is on: silently accruing storage charges on
evidence a customer forgot they were keeping is the surprise the whole
pricing model exists to avoid, and the way to avoid it is to make the state
visible before the bill arrives. `noBillingGate: true` — reading your own
retention posture is never a charge.

## Input

None (`{}`). Reads the caller's active org scope.

## Output

| Field | Type | Notes |
|---|---|---|
| `includedMonths` | `number` | Months of evidence retention included on every paid tier. |
| `effectiveRetentionDays` | `number \| null` | The longest retention window any of this organisation's pinned retention policies declares, in days, or `null` when none is pinned yet. Null means the organisation has not declared one — not that evidence is kept forever. |
| `extendedRetentionEnabled` | `boolean` | Whether this organisation pays for retention beyond the included window. `false` is the default and means nothing accrues (spec §7.4). |
| `usdPerGbMonth` | `number` | Extended-retention rate. |
| `storedGbBeyondIncluded` | `number \| null` | Evidence volume held beyond the included window, in GB. `null` when it has not been measured yet — see `storedGbMeasured`. A `null` here is the honest answer; a `0` would read as "you are storing nothing", which is a different and possibly false claim. |
| `storedGbMeasured` | `boolean` | Whether `storedGbBeyondIncluded` is a measurement or an absence. `false` means the accounting job has not run for this organisation yet. |
| `creditsChargedThisPeriod` | `number` | Retention credits charged to this organisation in the current period. |

## Roles

Org: Owner, Admin, Billing. Workspace: none.

## Side effects

None — read only. Reads the organisation's pinned retention policies and its
measured storage row; no writes.

## Errors

| code | meaning |
|---|---|
| `tenant_missing` | No active tenant on the request context. |
| `forbidden` | Caller lacks a billing-manager role on org. |

## Surfaces

- **API:** `GET /v1/:org/:workspace/billing/evidence/retention`
- **MCP:** tool `get_evidence_retention`

## SPEC references

- [ADR-052](../adr/ADR-052-governed-action-as-the-billable-unit.md) §4.3 —
  evidence retention as the second meter
- [`docs/specs/governed-action-metering.md`](../specs/governed-action-metering.md)
  §7.4 — extended retention is opt-in and never accrues by default
