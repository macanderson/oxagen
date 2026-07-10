---
# Workspace Overview

- **Route:** `/{orgSlug}/{workspaceSlug}`
- **Nav location:** workspace → primary → Overview (top of nav, above Ask)
- **Priority:** P2
- **Disposition vs today:** New

## Purpose
An at-a-glance control-plane home for a workspace: what it costs, what it's doing, how grounded its answers are, and what needs a human's attention. Today `/{orgSlug}/{workspaceSlug}` is a bare redirect straight to `/ask`; this page gives operators and billing-conscious admins a reason to land here first without weakening Ask as the default conversational front door.

## Primary user & jobs-to-be-done
- **Primary user:** workspace admin / team lead who resells or operates agents for this workspace
- **JTBD:**
  - See current-period spend and whether usage is trending up before the invoice arrives
  - Confirm recent agent runs are succeeding, not silently failing
  - Check that graph grounding is populated (not an empty, ungrounded workspace)
  - Verify connected knowledge sources are healthy
  - Jump straight to anything awaiting review (semantic edges, plans, memory promotions)

## Functionality
- **Spend tile:** current-period total (from `billing.usage.breakdown`) + daily trend sparkline; link to full billing/usage page.
- **Recent runs list:** last N `agent.execution.list` rows (status, agent, duration, cost); link to Activity.
- **Graph grounding stats:** node/edge counts, freshness, coverage from `graph.stats`; link to Knowledge/graph explorer.
- **Connected sources health:** `connection.list` rows with status chips (healthy/degraded/error); link to Knowledge → Sources.
- **Pending review quick links:** counts only (semantic edge suggestions, plan approvals, memory promotions) each linking to its owning surface — this page does not itself resolve reviews.
- No filters; this is a read-only summary/launchpad, refresh on load.

## Capabilities invoked
- `billing.usage.breakdown` (`get_usage_breakdown`) — current-period spend + daily trend tile.
- `agent.execution.list` (`list_executions`) — recent runs preview.
- `graph.stats` (`get_graph_stats`) — graph grounding health tile.
- `connection.list` (`list_connections`) — connected source health tile.

## Data sources
ClickHouse via `billing.usage.breakdown` (usage/cost events); Postgres via `agent.execution.list` (run metadata) and `connection.list` (connector operational record); Neo4j via `graph.stats` (node/edge/coverage counts).

## States
- **Empty:** brand-new workspace — show zero-state cards inviting first Ask, first connector, first agent run instead of blank tiles.
- **Loading:** independent Suspense boundary per tile; skeleton per card, parallel fail-open (one tile failing doesn't block the others).
- **Error:** per-tile inline error with retry; never a full-page error for one failed data source.

## Existing implementation
- **Today:** `apps/app/src/app/[orgSlug]/[workspaceSlug]/page.tsx` is a one-line `redirect()` to `workspace.ask(...)`. No dashboard exists. Build new: reuse existing tile/card primitives and the Suspense-per-section pattern already used in `activity/[executionId]/page.tsx`.

## Vision alignment
Surfaces the ClickHouse→Stripe metering loop and graph-grounding health as the first thing an operator sees — directly forward on the metering→billing and graph-grounding pillars, hence P2 (valuable, non-blocking since `/ask` remains the functional front door).
