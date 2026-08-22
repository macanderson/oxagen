---
# Billing — Usage / Metering

- **Route:** `/{orgSlug}/billing/usage`
- **Nav location:** org → Billing & Revenue → tab "Usage"
- **Priority:** P1
- **Disposition vs today:** Keep (the metering wedge dashboard)

## Purpose
Usage is the observed-usage half of the ClickHouse→Stripe loop — the dashboard proving that every capability invocation, agent step, and LLM call is captured as a priceable event. It is revenue infrastructure, not a spend dashboard: it exists so a billing manager can see exactly what is being metered, at what granularity, before it becomes an invoice or (via the Revenue tab) a re-bill to a reseller's own customers.

## Primary user & jobs-to-be-done
- **Primary user:** Billing manager
- **JTBD:**
  - See total metered usage and cost for the current period at a glance.
  - Understand which models, surfaces, workspaces, capabilities, and principals are driving usage.
  - Spot a usage spike early via daily trend view.
  - Trust that the numbers reflect real observed events, not estimates.

## Functionality
- **KPI tiles:** total metered cost (period), total events, top model, top capability.
- **Daily trend chart:** usage/cost over time, selectable period.
- **Breakdown tables:** by model, by surface (app/api/mcp), by workspace, by capability, by principal (acting user/agent) — each sortable, each linking to a filtered detail view.
- Degrades gracefully to a zeroed view with an explanatory banner if the ClickHouse read fails or returns no data.
- Access gated: `assertOrgMember` then `assertBillingManager` before invoking the breakdown.

## Capabilities invoked
- `billing.usage.breakdown` (`get_usage_breakdown`) — the sole data source, pulling from ClickHouse.

## Data sources
ClickHouse (append-only runtime events: execution events, token usage, tool calls) → priced via `get_usage_breakdown`.

## States
- **Empty:** brand-new org/workspace with no usage yet → zeroed KPI tiles with "No usage recorded yet" message, not an error.
- **Loading:** skeleton KPI tiles and chart while the breakdown query resolves.
- **Error:** ClickHouse unavailable → zeroed view plus a visible banner explaining metering is temporarily unavailable (never silently show stale/wrong numbers).

## Existing implementation
- **Today:** COMPLETE — `assertOrgMember` + `assertBillingManager` gate, then `invoke(get_usage_breakdown)` (ClickHouse); KPI tiles, daily trends, per-model/surface/workspace/capability/principal tables; degrades to zeroed view + banner on failure. Reuse as-is.

## Vision alignment
THE observed-usage half of the ClickHouse→Stripe loop — every capability, agent step, and LLM call emits a priceable event here. P1 because this is the metering wedge made visible, the foundation the Revenue tab (reseller re-billing) builds on.
