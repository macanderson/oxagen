# billing.action_usage

**Domain:** billing
**Mode:** sync
**Scope:** org + workspace (Owner, Admin, Billing)
**Surfaces:** api, mcp, agent
**Risk level:** low
**Capability name:** `get_action_usage`

## Intent

What the organisation has spent its governance budget on this entitlement
year: actions taken, actions the plan allowance absorbed, actions charged as
overage, the volume band that priced them, and the model spend that was
reported at zero beside them (ADR-052,
[`docs/specs/governed-action-metering.md`](../specs/governed-action-metering.md)).

This is the page a customer opens to answer "why is my bill this number".
Read-only, `noBillingGate: true` — an organisation that has run out of credits
must still be able to see that it has run out.

## Input

| Field | Type | Notes |
|---|---|---|
| `includeBreakdown` | `boolean`, optional, default `false` | Include the per-capability breakdown (`byCapability`). Off by default: it is a ClickHouse scan, while the headline numbers come from one indexed Postgres row. |

## Output

| Field | Type | Notes |
|---|---|---|
| `period` | `{ start, end }` | ISO-8601 bounds of the current entitlement year. |
| `actionsUsed` | `number` | Governed actions taken in the period, allowance-covered ones included. |
| `actionsIncluded` | `number` | Included in the plan and therefore free. |
| `actionsWithinAllowance` | `number` | Of those taken, how many the allowance absorbed. |
| `actionsCharged` | `number` | Of those taken, how many priced as overage. |
| `actionsRemaining` | `number` | Actions left before overage begins; zero once the allowance is spent. |
| `band` | `{ id, usdPer1000 }` | The volume band in force. |
| `creditsCharged` | `number` | Credits charged for overage so far, at the band in force when each action landed (incremental, running-band pricing). |
| `creditsAtFinalBand` | `number` | What the whole period's overage would cost priced at the single band the year-end total lands in — the spec §4.1 rule as written. |
| `bandTrueUpCredits` | `number` | `creditsCharged − creditsAtFinalBand`, zero or positive. A customer who crossed a band boundary mid-year is owed this true-up; it is reported rather than silently absorbed. |
| `meterMode` | `"shadow" \| "charge"` | Whether the meter is charging or only counting (spec §7.5). |
| `modelSpend.reportedCostMicros` | `number` (micro-USD) | Provider token cost over the period, reported in full (spec §4.4). |
| `modelSpend.chargedCredits` | `number` | Always zero for tokens the customer's own key paid for. The line exists rather than being omitted — the zero is the message. |
| `modelSpend.assistantTokenCredits` | `number` | ADR-053 §3: tokens the PLATFORM key paid for are the one exception and are billed back. Zero for an organisation on its own key. |
| `byCapability` | `{ capability, actions }[]` | Present only when `includeBreakdown` was set. |

## Roles

Org: Owner, Admin, Billing. Workspace: none.

## Side effects

- Postgres: read-only, one indexed row for the headline counters.
- ClickHouse: read-only aggregate, only when `includeBreakdown` is set.
- Neo4j: none.

## Errors

| code | meaning |
|---|---|
| `tenant_missing` | No active tenant on the request context. |
| `forbidden` | Caller lacks a billing-manager role on org. |

## Surfaces

- **API:** `GET /v1/:org/:workspace/billing/actions/usage?include_breakdown`
- **MCP:** tool `get_action_usage`

## SPEC references

- [ADR-052](../adr/ADR-052-governed-action-as-the-billable-unit.md)
- [`docs/specs/governed-action-metering.md`](../specs/governed-action-metering.md)
  §4.1 (bands / true-up), §4.4 (model tokens reported at zero), §7.5 (shadow vs.
  charge mode)
