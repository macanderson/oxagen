# 03 — Information architecture

Where things live, how nav is wired, and — the make-or-break part — which filter applies to
which tile.

## 1. Nav is data-driven from two files (single source of truth)

Every sidebar (org / workspace / account) is rendered by `apps/app/src/components/shell/sidebar.tsx`
from data in:

- **`apps/app/src/lib/sidebar.ts`** — `orgConfig`, `workspaceConfig`, `accountConfig`
  (`SidebarItem[]`), plus `ORG_SCOPE_ROUTES` and `enumerateNavTargets()` (Cmd+K).
- **`apps/app/src/lib/routes.ts`** — `org`, `workspace`, `account` route builders. No URL string
  is hard-coded elsewhere — **add every new route here first.**

Adding a nav destination = edit `routes.ts` (URL) + `sidebar.ts` (item + `enumerateNavTargets`).

## 2. Surface A — org dashboard at `/{org-slug}/dashboard`

### 2.1 The routing edits (in order)

1. **`routes.ts`** — add to the `org` object:
   `dashboard: (ctx) => ` `/${ctx.orgSlug}/dashboard` `` (and sub-tabs if we use a tabbed
   layout, e.g. `org.dashboard.usage`).
2. **`sidebar.ts` → `ORG_SCOPE_ROUTES`** — **add `"dashboard"` to the Set.** ⚠ **This is the
   landmine:** `resolveSidebarMode()` treats any `/{org}/{seg}` whose `seg` is *not* in this Set
   as a **workspace** slug. Miss this and `/{org}/dashboard` renders in workspace mode against a
   non-existent workspace "dashboard" → broken shell.
3. **`sidebar.ts` → `orgConfig`** — add a `{ id: "dashboard", label: "Dashboard", icon:
   LayoutDashboard, href: (ctx) => org.dashboard(ctx), group: "primary" }` item, placed **first**
   (it's the org home).
4. **`sidebar.ts` → `enumerateNavTargets()`** — add the org-dashboard target(s) for Cmd+K.
5. **`apps/app/src/app/[orgSlug]/page.tsx`** (the org root redirect) — repoint from
   "first workspace" to the dashboard. **Use `requestScopeSlugs()` (reads the `x-url` header),
   never `await params`** — awaiting params before `redirect()` under Cache Components degrades
   the 307 into a client meta-refresh that 500s the shell. Canonical pattern:
   `apps/app/src/app/[orgSlug]/billing/page.tsx`.

   ```ts
   // apps/app/src/app/[orgSlug]/page.tsx (revised)
   const { orgSlug } = await requestScopeSlugs();
   if (!orgSlug) redirect("/");
   // Empty-org guard: an org with zero workspaces still gets a dashboard,
   // but the dashboard itself shows the onboarding/empty state — do NOT
   // redirect an empty org to /new-workspace in a way that loops.
   redirect(org.dashboard({ orgSlug }));
   ```

   **Empty-org behavior change (flagged):** today `/{org}` sends a zero-workspace org to
   `/new-workspace`. After this change it lands on the dashboard, which must render a first-run
   empty state ("No usage yet — create a workspace") with a CTA — **not** bounce back, or we
   create a redirect loop. Keep the `/new-workspace` CTA *inside* the empty dashboard.

### 2.2 Page shape

Prefer a **tabbed section** mirroring `billing/layout.tsx` (`PageTabs` +
`MobileSettingsNav`), so the dashboard can grow:

```
/{org}/dashboard            → Overview  (the stat boxes; default)
/{org}/dashboard/usage      → Usage     (the deep breakdown: charts + by-* tables)
```

`layout.tsx` declares `tabs = [{label:"Overview", href: org.dashboard(ctx)}, {label:"Usage",
href: org.dashboard.usage(ctx)}]`. The Overview tab is the sexy at-a-glance strip; the Usage tab
is the power-user drill-down (reusing `billing/usage/*` components — `usage-charts.tsx`,
`usage-breakdown-view.tsx`, `usage-range-picker.tsx`). Default org scope: **all workspaces, this
month**, org timezone.

## 3. Surface B — user Usage tab at `/account/usage`

The account section is **global / user-scoped** (outside `[orgSlug]`). Its "tabs" *are* the
`accountConfig` sidebar items. Four edits + one page:

1. **`routes.ts`** — add to `account`: `usage: () => "/account/usage"`.
2. **`sidebar.ts` → `accountConfig.items`** — add `{ id: "usage", label: "Usage", icon:
   BarChart3, href: () => account.usage(), group: "primary" }` (after Privacy). Import the icon.
3. **`sidebar.ts` → `enumerateNavTargets()`** — add the account/usage target.
4. **Create `apps/app/src/app/account/usage/page.tsx`** — renders the same `UsageStatCard`
   strip + breakdowns, fed by **`get_my_usage`** (self-scoped, cross-org). Default view: current
   workspace (from the last-active tenant cookie) with an **Org** selector defaulting to "All
   orgs." Because it's cross-org, the workspace/org selectors here are *user-owned* lists, not
   the ambient tenant.

## 4. Surface C — workspace overview enhancements at `/{org}/{workspace}`

The overview *is* `[orgSlug]/[workspaceSlug]/page.tsx` (no `/overview` subroute). Enhancements
land as tiles under `.../[workspaceSlug]/_overview/` wired into `page.tsx`:

- Unify `MeteringKpiStrip` onto the shared **`UsageStatCard`** (§04).
- Add the missing core stats to the strip: **Chat turns, Cache-read share, PRs, Commits,
  Generated artifacts** (docs/images/videos).
- Add a **"vs. org" delta** on each KPI (this workspace's share of org total this period) so a
  workspace reads in context. Stays **workspace-scoped by default** (the stated requirement).
- Reuse the existing `GraphHero` / `MemoriesPanel` / `AutomationsPanel` for the tier-2 metrics
  (they already read `get_graph_stats` etc.).

## 5. The global filter model

One filter bar, shared component (`UsageFilterBar`), used on all three surfaces. Filters:

`timeframe` (preset+custom) · `workspace` · `user` · `model` · `provider` · `surface` ·
`capability` · `agent` (Phase 3) · `repo` (Phase 3) · `environment` (Phase 3).

Filter state lives in the **URL query string** (shareable, back-button-friendly, RSC-readable):
`?range=this_month&model=claude-fable-5&surface=mcp&workspace=…`. The server component reads
`searchParams`, maps them to the contract's `WHERE`-clause inputs (§02 §2.1), and re-queries —
so a filter is a **narrower query**, not client-side slicing of a huge payload. Filter *option
lists* are themselves derived from the data (distinct `model`/`provider`/`surface`/`capability`
seen in the window) so they never show a stale hard-coded enum.

## 6. ⚠ The filter-applicability matrix (this is where "good UX" is won)

The tiles read heterogeneous stores with **different filterable dimensions**. A bar that offers
`surface = MCP` and then silently leaves the "Automations created" tile unchanged reads as
broken. So every filter × tile pairing is one of: **✅ filters** · **➖ ignored (with
affordance)** · **⬚ hidden**. Rule: **never silently ignore** — if a filter can't apply to a
tile, the tile shows a muted "not filterable by *surface*" chip (or dims), so the user knows the
number didn't change *on purpose*.

| Filter → / Tile ↓ | time | workspace | user | model | provider | surface | capability | agent* | repo* | env* |
|---|---|---|---|---|---|---|---|---|---|---|
| **Token/cost/executions** (`token_usage`) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Chat turns** (`token_usage` distinct step) | ✅ | ✅ | ✅ | ➖ | ➖ | ✅ | ➖ | ✅ | ✅ | ✅ |
| **Capability breakdown** (`token_usage`) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| **Generated assets** (`generated_assets`) | ✅ | ✅ | ✅ | ✅ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ |
| **Automations created** (`playbooks`) | ✅ | ✅ | ✅ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ |
| **Agent runs** (`agent_executions`) | ✅ | ✅ | ➖¹ | ➖ | ➖ | ➖ | ➖ | ✅ | ➖ | ➖ |
| **Memories created** (Neo4j) | ✅ | ✅ | ✅² | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ |
| **Graph nodes/edges** (`graph.stats`/`tool_invocations`) | ✅ | ✅ | ➖ | ➖ | ➖ | ✅³ | ✅³ | ➖ | ➖ | ➖ |
| **Repo activity: PRs/commits** (`tool_invocations`) | ✅ | ✅ | ✅ | ➖ | ➖ | ✅ | — | ✅ | ✅⁴ | ✅ |

\* `agent` / `repo` / `env` columns don't exist on `token_usage` until **Phase 3** — until then
those three filters are rendered **disabled with a "coming soon" tooltip** everywhere, not shown
as working. `repo` on the repo-activity tile (⁴) is derivable earlier from the invocation
target. ¹ per-user on runs is indirect (via `token_usage.user_id`); ² Neo4j `created_by_id`
where kind=human; ³ deletes carry `surface`/`capability` on `tool_invocations`, the Neo4j
population count does not.

**Fallback behavior spec:** when a filter is `➖` for a tile, the tile stays visible and live but
renders a small muted note ("Not filterable by *model*") beside its title and does **not** apply
that predicate. When *every* active filter is `➖`/`⬚` for a tile (the user has filtered to a
dimension the tile can't honor at all), dim the tile to ~40% opacity with a single "Filtered out
by current slice" overlay — present, explained, not silently wrong.

## 7. Interaction & feedback patterns (ux-architect concerns)

- **Drill-in:** each `by-*` row and each KPI is a link that pushes the corresponding filter into
  the URL (click "Acme workspace" row → `?workspace=acme`), so drilling is just narrowing the
  same view. Breadcrumbs = the active filter chips (removable).
- **Loading:** per-tile Suspense skeletons (`stat-cards-skeleton.tsx`); the strip never blocks on
  the slowest tile.
- **Empty / degraded:** ClickHouse outage → token tiles show "—" with a "metering temporarily
  unavailable" hint; Postgres tiles stay live (fail-open composition, §02 §4).
- **Permission visibility:** org dashboard requires org membership (gate at the page —
  `assertOrgMember`; `apps/app` does not bootstrap IAM, so the gate is explicit, per CLAUDE.md).
  Cost/spend numbers are gated to billing-managers (`assertBillingManager`) — non-managers see
  usage counts (tokens/executions/artifacts) but the **cost** tiles are hidden, not zeroed.
- **Export:** a "Download CSV" affordance on the Usage tab (the by-* tables) — the reseller/
  finance workflow. Server action streams the aggregation as CSV.
