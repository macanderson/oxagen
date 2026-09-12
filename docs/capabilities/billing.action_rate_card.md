# billing.action_rate_card

**Domain:** billing
**Mode:** sync
**Scope:** org + workspace (Owner, Admin, Billing, Member)
**Surfaces:** api, mcp, agent
**Risk level:** low
**Capability name:** `get_rate_card`

## Intent

The published price of a governed action (ADR-052,
[`docs/specs/governed-action-metering.md`](../specs/governed-action-metering.md)
§4): the volume bands per 1,000 governed actions, the per-tier included
allowances, the evidence-retention price beyond the included window, and
confirmation that model tokens are reported at zero charge.

Read-only and static — it reads constants, not the organisation's data, so two
customers on the same tier see the same published table. That is the point: a
price a buyer cannot see before they buy is exactly what ADR-052 rejects
cost-derived credits for. `noBillingGate: true` — charging someone to read the
rate card would be the same mistake as charging them to read their bill.

## Input

None (`{}`). Reads the caller's active org scope only to attach `yourTier` /
`yourIncludedActionsAnnual` to the otherwise-static table.

## Output

| Field | Type | Notes |
|---|---|---|
| `unit` | `"governed_action"` | The billable unit, spelled out for a human reading the response. |
| `summary` | `string` | One sentence a buyer can check against their statements. |
| `bands` | `RateBand[]` | Volume bands, see below. |
| `tiers` | `TierAllowance[]` | Per-tier included allowances, see below. |
| `retention` | object | `{ includedMonths, usdPerGbMonth, optIn: true }` — extended retention is opt-in and never accrues by default (spec §7.4). |
| `modelTokens` | object | `{ usdPerToken: 0, explanation }` — always zero. The zero is the message, not an omission (spec §4.4). |
| `yourTier` | `"free" \| "build" \| "scale" \| "enterprise"` | The caller's own tier, so the published table can be read against it. |
| `yourIncludedActionsAnnual` | `number` | The caller's own included allowance, from their plan row. |

### `RateBand`

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Stable band identifier, e.g. `"1m-5m"`. |
| `minAnnualActions` | `number` | Inclusive lower bound in annual governed actions. |
| `maxAnnualActions` | `number \| null` | Exclusive upper bound, or `null` on the top band. |
| `usdPer1000` | `number` | USD per 1,000 governed actions. |

### `TierAllowance`

| Field | Type | Notes |
|---|---|---|
| `tier` | `"free" \| "build" \| "scale" \| "enterprise"` | |
| `includedActionsAnnual` | `number \| null` | Governed actions included per entitlement year, or `null` when the figure is negotiated per contract (enterprise). Null means "see your agreement", never "unlimited". |
| `retentionMonths` | `number` | Evidence retention included, in months. |

## Roles

Org: Owner, Admin, Billing, Member. Workspace: none.

## Side effects

None — read only. The table is static (published constants); only
`yourTier` / `yourIncludedActionsAnnual` are read from the caller's own plan
row.

## Errors

| code | meaning |
|---|---|
| `tenant_missing` | No active tenant on the request context. |

## Surfaces

- **API:** `GET /v1/:org/:workspace/billing/actions/rate-card`
- **MCP:** tool `get_rate_card`

## SPEC references

- [ADR-052](../adr/ADR-052-governed-action-as-the-billable-unit.md) — the
  governed action as the billable unit, tokens reported at zero
- [`docs/specs/governed-action-metering.md`](../specs/governed-action-metering.md)
  §4 — rate card, tier allowances
