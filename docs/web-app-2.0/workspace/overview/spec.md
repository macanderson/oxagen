---
# Workspace Overview

- **Route:** `/{orgSlug}/{workspaceSlug}`
- **Nav location:** workspace → primary → Overview (top of nav, above Ask)
- **Priority:** P2
- **Disposition vs today:** New

## Purpose
The control-plane home for a workspace: a live heads-up display (HUD) of what it
costs, what it's doing, what's automated, what it remembers, and how grounded its
answers are — plus what needs a human's attention. `/ask` remains the default
conversational front door via the nav; this page gives operators and
billing-conscious admins a reason to land here first.

## Primary user & jobs-to-be-done
- **Primary user:** workspace admin / team lead who resells or operates agents for this workspace
- **JTBD:**
  - See current-period spend, tokens used, and credit balance remaining before the invoice arrives
  - Confirm recent agent runs are succeeding, not silently failing
  - See what's automated and whether automations are active or paused
  - Watch the knowledge graph grow (nodes created today vs yesterday, this week vs last) and stay grounded
  - Review what the agents are remembering
  - Jump straight to anything awaiting review (inferred edges pending approval, memory promotions)

## Functionality
- **KPI strip (metering wedge):** month-to-date spend, tokens used, agent runs — each with a daily-trend sparkline — plus credit balance remaining. Billing-gated as a group; a non-billing member sees a single "requires billing access" card. Sources: `billing.usage.breakdown` (daily series) + `billing.subscription.read` (`creditBalanceCents` — the one true "remaining" number, never a fabricated quota).
- **Knowledge-graph hero (grounding wedge, made visual):**
  - a tiny live subgraph preview (`graph.export` sample → reagraph canvas, client-only, dashed edges = inferred);
  - stat cells: nodes, edges, inferred edges **pending approval** (`semantic.edge.suggest.total`), connected repos + data sources (`connection.list`, split by connector);
  - node-creation growth: today vs yesterday and this week vs last week (delta chips), plus a 14-day daily-node bar (`graph.stats` `includeGrowth`).
- **Agent activity:** runs-per-day mini-bars + succeeded/failed/running summary + the five most recent runs (`agent.execution.list`).
- **Automations:** active vs paused counts + recent automations (`automation.list`).
- **Usage charts:** daily cost/token stacked bar + top models bar list (`billing.usage.breakdown`, reaviz, client-only; billing-gated).
- **Memory captured:** memories captured this week (vs last) + the five most recent (`agent.memory.list`).
- **Source health:** `connection.list` rows with healthy/degraded/errored status chips.
- **Needs attention:** quick links to the surfaces that own reviews (inferred edges, memory, Ask).
- No filters; read-only summary/launchpad, refresh on load.

## Capabilities invoked
- `billing.usage.breakdown` (`get_usage_breakdown`) — KPI trends + usage charts.
- `billing.subscription.read` (`get_subscription`) — credit balance remaining.
- `agent.execution.list` (`list_executions`) — activity panel.
- `automation.list` (`list_automations`) — automations panel.
- `agent.memory.list` (`list_memories`) — memory panel.
- `graph.stats` (`get_graph_stats`, `includeGrowth`) — graph counts + node-creation growth.
- `graph.export` (`export_graph`) — sample subgraph for the live preview.
- `semantic.edge.suggest` (`suggest_semantic_edges`) — inferred edges pending approval count.
- `connection.list` (`list_connections`) — repos / data sources / source health.

## Data sources
ClickHouse via `billing.usage.breakdown` (usage/cost/token events); Postgres via
`billing.subscription.read`, `agent.execution.list`, `automation.list`,
`connection.list` (transactional state); Neo4j via `graph.stats`, `graph.export`,
`semantic.edge.suggest`, `agent.memory.list` (graph, subgraph, inferred edges,
memory).

## States
- **Empty:** brand-new workspace — each section shows a zero-state inviting the first Ask, connector, automation, or memory instead of blank tiles.
- **Loading:** independent Suspense boundary per section; skeleton per card, parallel fail-open (one section failing doesn't block the others).
- **Error:** per-section inline error/degraded state; never a full-page error for one failed data source. Billing sections degrade to a "requires billing access" card for non-billing members.

## Existing implementation
- The workspace root renders this HUD directly (it replaced an earlier one-line
  `redirect()` to `/ask`, then a bare four-tile stub). Sections live in
  `apps/app/src/app/[orgSlug]/[workspaceSlug]/_overview/`; shared HUD primitives
  (`StatCard`, `DeltaChip`, `MiniBars`, `Sparkline`) live in `_overview/hud/`.
  The reagraph preview is code-split via `next/dynamic({ ssr: false })`.

## Vision alignment
Surfaces the ClickHouse→Stripe metering loop, contract-governed automation, and
graph-grounding health as the first thing an operator sees — directly forward on
the metering→billing and graph-grounding pillars, hence P2 (valuable,
non-blocking since `/ask` remains the functional front door).
