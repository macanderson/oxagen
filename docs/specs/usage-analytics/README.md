# Usage Analytics — stat boxes for users, workspaces, and orgs

> Status: **proposal / design spec.** Author: product + design pass, 2026-07-17.
> Scope: `apps/app`, `packages/telemetry`, `packages/oxagen` (contracts), `apps/api`, `apps/mcp`.
> North star: [`docs/VISION.md`](../../VISION.md). Sits in the **metering → billing / cost-attribution** wedge.

## The ask, in one line

Surface Oxagen's metered usage as first-class, drill-in stat boxes: a **summary box on the
user's profile** plus a new *Usage* tab (`/account/usage`) for the drill-down, an enhanced
**workspace overview** (already partly there), and a brand-new **org dashboard** at
`/{org-slug}` → `/{org-slug}/dashboard`. Make it
sexy, make it honest, and let a human slice usage by org, workspace, user, model, provider,
surface, agent, repo, environment, capability, and timeframe.

## The one fact that shapes everything

Oxagen already draws a hard architectural line (see
[`docs/specs/analytics/posthog-product-analytics-requirements.md`](../analytics/posthog-product-analytics-requirements.md) §1):

> **PostHog is product analytics. ClickHouse is system telemetry / LLM metering** via the
> `invoke()` chokepoint. Do not duplicate machine telemetry into PostHog. The bridge between
> them is *identity* (`org_id` / `workspace_id` / `user_id`), not event duplication.

Everything in this spec is **metering data** — executions, tokens, cache, cost, capability
counts — so it reads from **ClickHouse** (and the Postgres/Neo4j domain tables), never
PostHog. That keeps billing-grade numbers on the billing-grade store and directly advances
the vision's third pillar (*monetization: a ClickHouse→Stripe loop that turns observed usage
into billing*).

## What already exists (this is an extend-and-relocate job, not greenfield)

The investigation behind this spec (see file headers for exact `path:line`) found a working
metering foundation:

- **`get_usage_breakdown`** (`packages/oxagen/src/contracts/billing.usage.breakdown.ts`,
  handler `packages/handlers/src/billing.usage.breakdown.ts`, query
  `packages/telemetry/src/usage-analytics.ts::readUsageBreakdown`) — the aggregation spine.
  Returns `totals` + daily `series` + `byModel` / `bySurface` / `byWorkspace` / `byCapability`
  / `byPrincipal` over ClickHouse `token_usage`.
- A **full metering dashboard** already lives at `apps/app/src/app/[orgSlug]/billing/usage/`
  (range picker → charts → tables), and a **workspace Overview HUD** at
  `apps/app/src/app/[orgSlug]/[workspaceSlug]/page.tsx` (`MeteringKpiStrip`, `GraphHero`,
  `UsagePanel`, `MemoriesPanel`).
- Canonical components: `Stat` / `StatGroup` (`@oxagen/ui`), and app-local
  `StatCard` / `Sparkline` / `MiniBars` / `DeltaChip` under
  `apps/app/src/app/[orgSlug]/[workspaceSlug]/_overview/`. Charts are **reaviz**
  (`StackedBarChart`, `BarList`, `LineChart`, `RadialGauge`) always via `dynamic({ ssr: false })`.

So the org "Usage" page is largely the existing `billing/usage` dashboard **promoted** to a
top-level org dashboard and **widened** with more group-bys — one aggregation transport, not two.

## What this spec delivers

1. [`01-proposal.md`](./01-proposal.md) — the problem, the vision alignment, the three
   surfaces, and non-goals (the PostHog boundary).
2. [`02-data-model-and-metrics.md`](./02-data-model-and-metrics.md) — the **three honesty
   tiers**, the full metric→source map, the contract design (extend `get_usage_breakdown`;
   new self-scoped `get_my_usage`; new `get_generated_asset_stats` / `get_automation_stats`;
   reuse `get_graph_stats` / `list_executions`), the timeframe presets + previous-period map +
   366-day cap, and the honest cache-hit-rate definition.
3. [`03-information-architecture.md`](./03-information-architecture.md) — routing edits
   (the `ORG_SCOPE_ROUTES` landmine, the `/{org}` redirect, the empty-org case, nav configs,
   the `/account/usage` tab), the **global filter model**, and the load-bearing
   **filter-applicability matrix** (which filter applies to which tile).
4. [`04-wireframes.md`](./04-wireframes.md) — the canonical **UsageStatCard**, the org
   dashboard, the user Usage tab, and the workspace-overview enhancements.
5. [`05-build-plan-and-phases.md`](./05-build-plan-and-phases.md) — a phased build with the
   **Phase-0 MVP cut** that ships the org page fast, contract→route→MCP→UI parity per phase,
   tests, `capability-ui-map.json` bindings, and a Linear ticket breakdown.
6. `mockup.html` — a rendered, self-contained visual of the org dashboard + stat card
   (published as an Artifact) so "sexy" is *shown*, not asserted.

## The golden path this unlocks

> Open `app.oxagen.sh/acme`. It lands on the **org dashboard**. A stat strip shows this
> month's executions, chat turns, total tokens (in/out), cache-read share, cost, PRs, commits,
> and generated documents / images / videos — each with a period-over-period delta and a
> sparkline. Change the timeframe to *last quarter*; slice by *model = Claude Fable 5* and
> *surface = MCP*. Drill into *by workspace*, then *by user*. Click a user → their
> `/account/usage` tab shows the same box **filtered to them, across every org they touch**,
> defaulting to the current workspace. Every number traces to a typed contract, and the
> capability breakdown is derived from the *distinct capabilities actually used* — no names
> hard-coded.

## Honesty summary (read before promising anything)

| Tier | Metrics | Ships |
|---|---|---|
| **1 — backed now** | executions, chat turns, tokens in/out/total, cache-read share, cost, byModel/byProvider/bySurface/byCapability/byWorkspace/byPrincipal, byUser (one new GROUP BY), timeframe | Phase 0–1, reusing `get_usage_breakdown` |
| **2 — backed elsewhere (compose per store)** | memories created (Neo4j), agent runs (Postgres `agent_executions`), generated docs/images/videos/pdf/svg (Postgres `generated_assets`), automations created (Postgres `playbooks`), graph node/edge **creates** + **deletes** | Phase 2, one fail-open tile per store |
| **3 — not emitted yet (needs insert-path work)** | slice by **agent / agent-version / repo / environment**, real **cache miss / cache write**, graph node/edge **updates**, PR **merges**, `conversation_id` | Phase 3 (metering enrichment) — labeled *"coming"* in the UI until then |

## Note on the visual reference

The user's message referenced *"a stat box like this"* with an inline image, but **the image
did not reach the spec author as viewable content** (it arrived as a broken/empty paste). The
`UsageStatCard` in [`04-wireframes.md`](./04-wireframes.md) and `mockup.html` is designed from
the *text* description (label, big value, delta, sparkline, drill-in). **Please confirm it
matches the reference** — if not, share the image again and the card design is a cheap change.
