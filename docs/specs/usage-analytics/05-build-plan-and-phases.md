# 05 — Build plan & phases

Sequenced so the **headline ask ships first**. Each phase is independently mergeable, leaves the
gate green, and respects contract-wiring order (contract → API route → MCP tool → CLI → app UI)
+ UI Capability Parity (`capability-ui-map.json` binding with runtime proof).

## Phase 0 — Org dashboard MVP (reuse only, no new backend)  ·  ship this first

**Goal:** a real org home with the core stat strip, using **only** what `get_usage_breakdown`
already returns. This alone delivers most of the user's org ask.

Delivers from the existing contract: **executions (LLM calls), tokens in/out/total, cache-read
share, cost, byModel, byProvider, bySurface, byWorkspace, byCapability, daily series**, timeframe
presets + custom (≤366d), model/provider/surface filters (client→query).

Work:
1. Routing: add `org.dashboard` to `routes.ts`; add `"dashboard"` to `ORG_SCOPE_ROUTES`; add the
   `orgConfig` item + `enumerateNavTargets`; repoint `[orgSlug]/page.tsx` (via `requestScopeSlugs`)
   with the **empty-org** guard.
2. `apps/app/src/app/[orgSlug]/dashboard/{layout,page}.tsx` (tabbed: Overview + Usage). Usage tab
   reuses `billing/usage/*` components as-is.
3. `apps/app/src/components/usage/usage-stat-card.tsx` (unify HUD primitives) +
   `usage-filter-bar.tsx` (URL-query filter state).
4. Gate: `assertOrgMember` on the page; `assertBillingManager` around cost tiles (hide, don't
   zero, for non-managers).
5. Proof: e2e `apps/app/e2e/org-dashboard.spec.ts` + screenshot; `capability-ui-map.json` binding
   for `get_usage_breakdown` app layer (already app-layer — add the dashboard route binding).

**Model to run it:** Sonnet (multi-file app work, no new storage/security). ~3–4 files + routing.

## Phase 1 — `byUser` + cross-org `get_my_usage` (per-user surfaces)

**Goal:** the per-user slice everywhere + the user Usage tab.

1. **Extend `readUsageBreakdown`** to add `byUser[]` (`GROUP BY user_id`) and `messages`
   (`count(distinct execution_step_id)`); extend the `get_usage_breakdown` output schema + docs +
   `docs/capabilities/`. (Migration-free — columns exist.) Unit-test the new GROUP BY against a
   seeded ClickHouse fixture.
2. **New contract `get_my_usage`** (self-scoped, cross-org) — contract + `readMyUsage()` handler
   with the **`WHERE user_id = ctx.session-derived id`** guard (⚠ the sole isolation guard; test a
   cross-tenant-leak case explicitly) + API route + MCP tool + CLI command + app page
   `apps/app/src/app/account/usage/page.tsx` + `routes.ts`/`sidebar.ts` account tab.
3. Workspace overview: swap `MeteringKpiStrip` onto `UsageStatCard`, add the new stats + "vs org"
   delta.
4. Proof: e2e for `/account/usage` showing self-scoped, cross-org data; a security test asserting
   user A cannot see user B's rows; `capability-ui-map` binding for `get_my_usage`.

**Model:** **Opus** for the `get_my_usage` handler/contract (it deliberately breaks tenancy —
auth-sensitive, our rules require Opus + explicit gates); Sonnet for the UI wiring.

## Phase 2 — cross-store activity tiles (compose per store)

**Goal:** the non-token activity metrics, each an independent fail-open tile.

1. **`get_generated_asset_stats`** (Postgres `generated_assets`, `GROUP BY kind` + mime split for
   svg/mermaid, `source='generated'`) → contract→route→MCP→CLI→tile. Backs docs/images/videos.
2. **`get_automation_stats`** (Postgres `workflow.playbooks`) → automations created.
3. **`get_repo_activity_stats`** (ClickHouse `tool_invocations` counts of `open_pr`/`put_repo_file`
   + `audit`/`security` fallback) → PRs opened / commits.
4. **Reuse** `get_graph_stats` (nodes created + by-label/type; deletes via `tool_invocations`) and
   `list_executions`/a small `get_execution_stats` for agent runs — add `app`-layer bindings where
   missing.
5. **Memories:** either a Neo4j-reading `get_memory_stats` tile (per-user via `created_by_id`), or
   defer to Phase 3's `write_memory` emit. Recommend the Neo4j tile now (data exists) — label
   grain.
6. Each tile: unit test the aggregation, wire into org dashboard + user tab + workspace overview,
   apply the **filter-applicability matrix** fallbacks (§03 §6).

**Model:** Sonnet (several small contracts across known stores).

## Phase 3 — metering enrichment (unlock agent/repo/env + real cache)

**Goal:** the slices that have **no backing column today**. This is real insert-path work; it's
last because everything above ships without it, and until it lands those filters are rendered
**disabled with "coming soon."**

1. **Add columns to `token_usage`** (ClickHouse migration): `agent_id UUID`, `agent_version
   String/LowCardinality`, `repo_id UUID`, `environment_id UUID`, and populate `conversation_id`
   (exists) + `cache_creation_tokens UInt64` and start writing `cache_misses`. Timestamp-prefix
   the migration later than every existing file (atlas-collision rule).
2. **Populate at the insert boundary** — extend `currentPrincipalStamp()` /
   `getPrincipalAttribution()` (`@oxagen/tenancy`) so the ambient scope carries agent/repo/env the
   same way it already carries `user_id`/`capability_name`; set `cache_creation_tokens` from AI SDK
   `inputTokenDetails.cacheCreationTokens` in `packages/ai/src/stream.ts`. **This is the
   chokepoint work** — do it once at `insertTokenUsage`, not per caller.
3. **Extend `readUsageBreakdown`** with `byAgent[]`/`byRepo[]`/`byEnvironment[]` + the enrichment
   filters; flip the disabled UI filters live.
4. **Graph "updated" metric** (the single hardest gap): add a shared graph-mutation emit in the
   `graph.node.upsert`/`graph.edge.upsert` handlers (a `tool_invocations`-style row with
   `created|updated` distinguished) so node/edge *updates* become discrete, countable events.
5. **PR merges:** extend `apps/api/src/routes/v1/github-webhook.ts` (today ingestion-only) to emit
   a usage event on `pull_request.closed & merged`.
6. Backfill note: enrichment columns are **forward-only** (historical rows have nulls) — the UI
   shows "unattributed" for pre-enrichment data rather than dropping it.

**Model:** **Opus** (storage-boundary change + insert-path chokepoint + backfill semantics).

## Cross-cutting requirements (every phase)

- **Tests / gate.** New aggregation code needs unit tests against seeded fixtures; new pages need
  e2e + screenshots (`apps/app/e2e/screenshots/`). Follow the coverage-ratchet rule (bump only up
  to `floor(coverage − 2.5)`, never past 90, never down). **Never run the whole suite** — run only
  the implicated package's `test:unit` / the one new spec. `pnpm gate` once per finished phase
  before marking a PR ready.
- **Parity.** `pnpm check:manifest` clean (document the expected `get_my_usage` false-positive —
  no tenant-from-input); `pnpm check:ui-parity --strict` clean (every new `app`-layer capability
  bound with proof).
- **Docs.** Add `docs/capabilities/*.md` for each new contract; update `_index.md`.
- **Perf.** ClickHouse queries stay within the existing projection pattern (`AGG_SELECT`); add the
  `WHERE` predicates on already-indexed columns (`idx_token_model`, `idx_token_capability`,
  `idx_token_principal`). Cache the aggregation briefly (per-tenant, per-filter-hash) — these are
  read-heavy dashboard queries. Reuse the ClickHouse circuit breaker (fail-open).
- **Vendor-neutral.** `byProvider` must render every provider seen (anthropic/openai/google/bfl/
  xai/…), never privilege one — reinforces the BYOK constraint.

## Linear tickets (project `oxagen-v2`, assignee Mac Anderson)

One parent epic **"Usage analytics — user/workspace/org stat boxes"** (label `web-app`,
`billing`, `observability`; estimate L). Sub-issues = one PR each:

1. **Org dashboard MVP** (Phase 0) — `web-app` · M · P2. Routing + tabbed dashboard + UsageStatCard
   + filter bar, reusing `get_usage_breakdown`.
2. **byUser + get_my_usage** (Phase 1) — `billing`,`api`,`security` · M · P2. Extend breakdown;
   new self-scoped contract; account/usage tab; workspace-overview unification.
3. **Activity tiles** (Phase 2) — `web-app`,`observability` · M · P3. generated-asset / automation
   / repo-activity stat contracts + graph/memory reuse.
4. **Metering enrichment** (Phase 3) — `observability`,`database` · L · P3. `token_usage` columns +
   insert-path stamp + agent/repo/env slices + real cache + graph-updated emit + merge webhook.

Each ticket description carries: purpose sentence · link to this spec · explicit file/migration
list (from §02/§03) · acceptance checklist · risks (tenancy leak on `get_my_usage`; empty-org
redirect loop; `ORG_SCOPE_ROUTES` omission) + mitigations · rollback (routes/nav are additive;
enrichment migration is forward-only, revertible by dropping unused columns).

## Definition of done (headline ask)

- `/{org-slug}` lands on `/{org-slug}/dashboard` (empty-org shows onboarding, no loop).
- Org dashboard shows the core + capability-pack strips with deltas + sparklines, sliceable by
  timeframe/workspace/user/model/provider/surface; agent/repo/env filters visibly "coming."
- `/account/usage` shows the user's own footprint across all their orgs, workspace-defaulted,
  provably self-scoped.
- Workspace overview unified onto `UsageStatCard` with the added stats, workspace-scoped.
- Every number traces to a typed contract; capability counts are the *distinct* set; `pnpm gate`,
  `check:manifest`, and `check:ui-parity --strict` all green.
