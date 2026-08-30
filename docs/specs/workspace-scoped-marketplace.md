# Workspace-Scoped Marketplace

Archived spec & plan — status: partially shipped (audited 2026-07-03).

> **Status: Partially shipped** — verified against the codebase on 2026-07-03 by an automated audit.
>
> The workspace-scoped marketplace feature is substantially implemented with most core deliverables shipped, but diverges from the spec's architectural requirements. Database schema changes (workspace-scoped registries and installed_plugins with proper constraints) are complete. The single-default registry state machine, UI components (tabs fix, marketplace modal with 5 types, registry manager with help popover), and contract restructuring are all functional. However, the browse handler uses synced mcp.catalog_servers table instead of pure live HTTP reads with short-TTL cache as specified in section 3.2. The catalog table was initially dropped but re-added during later Epic work. No E2E tests are visible for marketplace/registry management.

**Implementation evidence**

- packages/database/src/schema/plugin.ts: pluginInstalledPlugins table with workspace_id NOT NULL and 6 plugin types
- packages/database/src/schema/mcp.ts: mcpRegistries with workspace_id NOT NULL, isDefault boolean, partial unique index on (org_id, workspace_id) WHERE is_default
- packages/handlers/src/registry-default.ts: single-default state machine with atomic promotion on default removal
- packages/handlers/src/workspace-registry-seed.ts: exactly-one-registry per workspace seeding logic
- packages/ui/src/components/tabs.tsx: data-[active]: attribute fix for Base UI Tabs component
- apps/app/src/components/plugins/marketplace-modal.tsx: 5-type marketplace tabs (agent_skill, agent_capability, mcp_server, knowledge_source, integration) without Oxagen/content_tool tabs
- apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/plugins/registry-manager.tsx: registry self-service UI with add/remove and help popover
- apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/plugins/page.tsx: workspace-scoped plugins settings page
- apps/docs/content/docs/plugins/registries.mdx: registry documentation page
- packages/oxagen/src/contracts/plugin.registry.add.ts: workspace-scoped contracts (scoped: true)
- packages/handlers/src/plugin.catalog.browse.ts: browse handler queries mcp.catalog_servers table (divergence from spec)
- no org-level plugins page at apps/app/src/app/[orgSlug]/settings/plugins/ (org-level deleted as spec required)

**Known gaps at time of archive**

- Pure live HTTP registry reads with short-TTL server-side cache (spec sec 3.2 explicitly required no sync machinery, but implementation prioritizes synced mcp.catalog_servers)
- E2E tests for marketplace/registry management workflows (no visible tests in apps/app/e2e/)
- mcp.catalog_servers table should have been dropped (spec Tasks 1-2) but still exists and is actively used

**Source documents** (archived verbatim below)

- `docs/specs/workspace-scoped-marketplace/SPEC.md`
- `docs/specs/workspace-scoped-marketplace/PLAN.md`

## Spec — `SPEC.md`

## Marketplace / Plugins — Workspace Scoping + Registry Simplification

**Date:** 2026-06-17
**Status:** DECISIONS RESOLVED (§7) — awaiting user approval of spec before implementation plan
**Author:** Claude (Opus 4.8) with Mac Anderson

---

### 1. Goal (in the user's words)

Re-scope the entire marketplace/plugin system from **org** to **org + workspace**, delete the
registry "sync" machinery in favor of **live HTTP reads**, collapse the "Oxagen Plugin"
abstraction into a flat **five-type plugin taxonomy**, fix the **broken marketplace tabs**, and give
workspaces **self-service registry management** (add/remove, with an enforced single-default rule)
plus an **in-context help popover** that links to docs.

End state: create a new workspace → click Marketplace in the sidebar → immediately see **all** MCP
servers from the seeded registry, fetched live. No sync. No org pre-approval. No "Oxagen Plugin" tab.

---

### 2. Current state (discovery findings)

#### 2.1 Data model (`packages/database/src/schema/`)
- `mcp.registries` — `org_id` (NULL ⇒ global seed), `name`, `base_url`, `enabled`, **`is_default_seed`**,
  **`last_synced_at`**, **`last_synced_cursor`**. **No `workspace_id`.** Unique on `COALESCE(org_id) + base_url`.
- `mcp.catalog_servers` — **the synced cache of installable MCP servers.** ← to be **DROPPED**.
- `mcp.credentials` — encrypted auth per (org_listing × workspace). `orgScopeMixin` (org+workspace). **Keep.**
- `mcp.mcp_servers` — installed server instances per org/workspace. `orgScopeMixin`. Links `org_listing_id`. **Keep.**
- `plugin.org_listings` — the install record. `org_id NOT NULL`, **`workspace_id` (nullable, recently added)**,
  `plugin_type` ∈ \{`mcp_server`,`integration`,`content_tool`,`capability`}, `catalog_server_id` (FK → dropped table),
  `source` ∈ \{registry,custom,oxagen}, denormalized identity (`name/title/description/icon_url/endpoint_url/transport/auth_kind`),
  `enabled` (default **false**), soft-delete. **Re-scope + retype.**
- `plugin.org_denylist` — org admin blocklist ("blocked by your organization's admins"). ← the org-preapproval mechanism.

#### 2.2 The duplicate-registry bug (root-caused)
- Migrations `20260614…seed_official_mcp_registry.sql` + `0000_baseline.sql` seed `base_url='https://registry.modelcontextprotocol.io'` (no path).
- `seed.ts` `OFFICIAL_MCP_REGISTRY.baseUrl='https://registry.modelcontextprotocol.io/v0.1/servers'` (**with** path).
- `registry-client.ts` **appends** `/v0.1/servers`, so the correct stored value has **no** suffix; the seed.ts constant is wrong.
- `ensureOfficialMcpRegistry()` guards its insert by matching on `base_url` → never matches the migration's row →
  **inserts a second NULL-org default-seed row** with a different URL. Migration `20260615…workspace_plugin_scope.sql`
  bolts on an after-the-fact `UPDATE … SET base_url=… WHERE base_url LIKE '%/v0.1/servers%'` cleanup. **This is the bug.**

#### 2.3 Sync machinery (to delete)
`mcp.catalog_servers` ← `packages/plugins/src/registry/sync-service.ts` ← `plugin.registry.sync`
(contract + API route `/plugin/registries/sync` + MCP tool + CLI command) ← `organization.create.ts` fire-and-forget
trigger (`eventClient.send("plugin/registry.sync")`) ← a 6-hour cron. Browse reads the synced table.

#### 2.4 Capability packs = "Oxagen Plugins" (to rename, not delete)
`packages/oxagen/src/plugins/registry.ts` builds a static registry of 4 manifests:
`oxagen/media-video`, `oxagen/media-image`, `oxagen/media-svg`, `oxagen/documents` — each claims a contract
(`svg.generate`, etc.), `tier`, `visibility`, `category:"media"`. The **kernel entitlement gate**
(`packages/plugins/src/entitlements/entitlement-service.ts`) blocks claimed contracts until installed+enabled in
`plugin.org_listings`. These are exactly the user's **`agent_capability`** plugins (seeded **uninstalled**).

#### 2.5 The broken tabs
`apps/app/src/components/plugins/marketplace-modal.tsx` wires Base UI Tabs correctly (`value`/`onValueChange`,
`TabsTab value=`, `TabsPanel value=`). The bug is in `packages/ui/src/components/tabs.tsx`: selected-state classes use
**`data-[selected]:`** but Base UI in this repo emits **`data-active`** (per memory `ui-base-ui-stock-shadcn`). State
flips on click but no class responds → no highlight, no panel change, no indicator move. **One-component fix, repo-wide benefit.**

#### 2.6 Surface inventory (parity must move in lockstep)
17 org-scoped + 1 workspace-scoped contract/route/MCP-tool/CLI quads under `plugin.*`. Latent IDOR found:
`plugin.workspace.set_enabled` accepts a body `workspaceId` never validated against the API-key's bound workspace.

#### 2.7 Partially-started migration (important)
Route folders **both** exist: `[orgSlug]/settings/plugins/` (org-plugins-panel) and
`[orgSlug]/[workspaceSlug]/settings/plugins/` (workspace-plugins-panel). `org_listings.workspace_id` already added
(nullable). So this is a **half-done migration to finish + correct**, not greenfield.

---

### 3. Target architecture

#### 3.1 Data model (after)
**`mcp.registries`** — add `workspace_id UUID NOT NULL`; **drop** `is_default_seed`, `last_synced_at`, `last_synced_cursor`;
add `is_default BOOLEAN NOT NULL` (per-workspace, exactly-one-true invariant). Unique `(org_id, workspace_id, base_url)`.
Every registry row is concrete and owned by one workspace (removable).

**`plugin.org_listings` → `plugin.installed_plugins`** (renamed): `workspace_id NOT NULL`, `plugin_type` ∈ the new 5,
**drop** `catalog_server_id` (identity already denormalized on the row; live data via HTTP).

**DROP:** `mcp.catalog_servers`, `plugin.org_denylist`.

**Plugin types (5):** `agent_skill`, `agent_capability`, `mcp_server`, `knowledge_source`, `integration`.
Mapping: `capability`→`agent_capability`; `content_tool`→`agent_capability`; **new:** `agent_skill`, `knowledge_source`.

#### 3.2 Live registry reads (no sync)
Browse calls `registry-client.ts` against each enabled workspace registry's `base_url` (live), merges results, overlays
install state from `installed_plugins`, and overlays the static `agent_capability`/`agent_skill` packs. A short-TTL
**server-side request cache** (runtime cache, ~60s) prevents hammering the upstream on keystrokes — this is a transient
cache, **not** a synced table, so it honors "no sync."

#### 3.3 Single-default registry state machine (one enforced rule, in one handler)
- 0 registries → fine.
- Adding when 0 exist → new row forced `is_default=true`.
- Adding when ≥1 exists → new row `is_default=false`.
- Exactly 1 registry → it is `is_default=true`, **immutable** (UI shows no toggle).
- Remove default with others present → **most-recently-added** remaining row promoted to default (atomic).
- Remove default with none remaining → fine.
- No user-facing "make default" toggle ever. Invariant enforced in the handler + a DB partial unique index
  (`UNIQUE (org_id, workspace_id) WHERE is_default`).

#### 3.4 Seeding (idempotent, exactly-one)
On **workspace** creation, insert exactly one registry: `(org_id, workspace_id, name='Official MCP Registry',
base_url='https://registry.modelcontextprotocol.io', is_default=true)`. Guarded by the `(org_id, workspace_id, base_url)`
unique index + select-then-insert. Fix the `seed.ts` URL constant (drop the `/v0.1/servers` suffix). Remove the
org-create sync trigger. **New unit test:** creating a workspace yields exactly one registry.

#### 3.5 UI
- **Move** the page to `[orgSlug]/[workspaceSlug]/settings/plugins`; retire the org-level page/panel.
- **Marketplace modal:** remove the "Oxagen Plugins" (`capability`) **tab** and the `content_tool` tab; tabs become the
  installable kinds the marketplace surfaces. Remove "blocked by your organization's admins" denylist UI.
- **Fix tabs** in `packages/ui` (data-attribute).
- **Registry management UI** (in workspace settings/plugins): list registries, add, remove (incl. default with promotion),
  with the single-default rule enforced visually (no toggle when count ≤ 1).
- **Help popover** beside the "Add registry" control: explains what a registry URL is, shows real examples
  (e.g. `https://registry.modelcontextprotocol.io`), and links to `${NEXT_APP_DOCS_URL}/<path>` — a new docs page.

#### 3.6 Capability parity
Every changed capability moves contract → API route → MCP tool → CLI together. Delete `plugin.registry.sync` across all
four. Fix the `plugin.workspace.set_enabled` IDOR while we're rewriting the scope gate. `pnpm check:manifest` stays green.

---

### 4. Test plan
- **Unit:** single-default state machine (all transitions); exactly-one-registry-on-workspace-create; seed URL correctness;
  browse live-merge + install overlay; entitlement gate still blocks uninstalled `agent_capability`.
- **Contract/route parity:** updated `route-contract-parity` + per-route tests; sync routes removed.
- **E2E:** new workspace → marketplace shows live MCP servers; add/remove registry incl. default-promotion; install a
  plugin and use it; tabs switch + animate (screenshots to `apps/app/e2e/screenshots/`).
- Coverage ratchets bumped (never lowered), per policy.

### 5. Migration strategy
Pre-launch, no live customers (CLAUDE.md) → **clean rebuild** (§7-A). Forward Atlas migration in `packages/database/`:
drop `mcp.catalog_servers` + `plugin.org_denylist`; rename `plugin.org_listings`→`plugin.installed_plugins` with
`workspace_id NOT NULL`; add `registries.workspace_id` (NOT NULL) + `is_default`, drop `is_default_seed`/`last_synced_*`;
retype `plugin_type` CHECK to the 5. RLS manifest + `oxagen_app` grants updated for renamed/changed tables (replay as
Atlas migrations so a re-baseline can't drop them — memory: prod-outage postmortem).

### 6. Risks
- **Kernel entitlement gate** must keep gating `agent_capability` packs after re-scope — covered by tests.
- **Live upstream latency/availability** — short TTL cache + graceful empty-state on registry fetch failure.
- **Atlas re-baseline loses non-Drizzle DDL** (RLS/grants) — replay as Atlas migrations (memory: prod-outage postmortem).

---

### 7. DECISIONS (RESOLVED 2026-06-17)

- **A. Data migration → CLEAN REBUILD.** Drop + recreate plugin/registry tables fresh in the new workspace-scoped
  shape. No backfill, no nullable legacy rows. Workspaces re-seed their default registry on creation.
- **B. `content_tool` → FOLD INTO `agent_capability`.** Any `content_tool` row/type becomes `agent_capability`; the
  `content_tool` type is removed from the CHECK and from all code.
- **C. `plugin.org_denylist` → DROP ENTIRELY.** Delete the table, the denylist contracts/routes/MCP tools/CLI, and all
  "blocked by your organization's admins" UI. Pure workspace self-service — no org-level install gating.
- **D. Rename `plugin.org_listings` → `plugin.installed_plugins`.** Workspace-scoped install record; the old name is
  retired across schema, handlers, RLS manifest, and all references.

#### Consequent invariants
- The only remaining org-vs-workspace gate is **tenancy** (RLS + scope checks), never "approval." Fix the
  `plugin.workspace.set_enabled` IDOR as part of the rewrite.
- The 5 `plugin_type` values are final: `agent_skill`, `agent_capability`, `mcp_server`, `knowledge_source`, `integration`.
- Seeded `agent_skill` packs install **enabled**; seeded `agent_capability` packs install **disabled** (uninstalled),
  surfaced in the marketplace for one-click enable.

## Plan — `PLAN.md`

## Marketplace Workspace-Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax. Each task is dispatched to a Sonnet worker; Opus advisor reviews between tasks.

**Goal:** Re-scope the entire plugin/marketplace system from org to org+workspace, replace registry "sync" with live HTTP reads, collapse to a 5-type plugin taxonomy, fix the broken Base UI tabs, and ship workspace-level registry self-service with a single-default rule.

**Architecture:** Postgres schema clean-rebuild (workspace-scoped `mcp.registries` + `plugin.installed_plugins`; drop `mcp.catalog_servers` + `plugin.org_denylist`). Browse reads registries live via the existing `registry-client.ts` with a short server-side TTL cache. Capability/skill packs come from the static `@oxagen/oxagen/plugins` registry, gated by the kernel entitlement service. All contracts/routes/MCP tools/CLI move to workspace scope in lockstep.

**Tech Stack:** Drizzle + Atlas (Postgres), Hono (API), xmcp (MCP), Commander+Ink (CLI), Next.js 16 App Router + Base UI (`@oxagen/ui`), Vitest + Playwright.

### Global Constraints (verbatim from spec + CLAUDE.md / engineering policy)
- Pre-launch, no live customers → **clean rebuild**, drop+recreate plugin/registry tables. Commit to `main` after `pnpm gate`.
- Plugin types are exactly 5: `agent_skill`, `agent_capability`, `mcp_server`, `knowledge_source`, `integration`.
- Seeded `agent_skill` packs install **enabled**; seeded `agent_capability` packs install **disabled** (marketplace-visible).
- No `any`; strict types; zero lint warnings (`--max-warnings 0`); pinned deps. New code requires new tests.
- Coverage thresholds are ratchets capped at 90; bump only to `floor(coverage − 2.5)`, never lower.
- UI imports from `@/components/ui/<name>`, never `@oxagen/ui/components/*` directly (except the re-export files).
- Migration files in `packages/database/` only. RLS manifest + `oxagen_app` grants replayed as Atlas migrations.
- Capability parity: contract → API route → MCP tool → CLI together; `pnpm check:manifest` stays green.
- Docs link uses `NEXT_APP_DOCS_URL` env var; help copy follows brand-voice policy.

---

### File Structure (what changes)

**Schema/DB** — `packages/database/src/schema/mcp.ts`, `.../plugin.ts`, `.../index.ts`, `src/seed.ts`, `src/tenant-policy.manifest.ts`, new Atlas migration under `packages/database/atlas/migrations/`.
**Backend** — `packages/handlers/src/plugin.*` (browse, install, list, registry.add/remove/list, set_enabled), new `packages/handlers/src/registry-default.ts` (state machine), `packages/handlers/src/organization.create.ts` (drop sync trigger), `packages/plugins/src/registry/` (drop sync-service, keep client/map-server), `packages/oxagen/src/contracts/plugin.*`, `packages/oxagen/src/plugins/*` (rename concept), seed scripts.
**Surfaces** — `apps/api/src/routes/v1/plugin.*` + `app.ts`, `apps/mcp/src/tools/plugin.*`, `apps/cli/src/commands/plugin.*`.
**UI** — `packages/ui/src/components/tabs.tsx` (data-attr fix), `apps/app/src/components/plugins/marketplace-modal.tsx`, `.../plugin-detail-panel.tsx`, `apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/plugins/*`, delete `apps/app/src/app/[orgSlug]/settings/plugins/*`, new registry-management + help-popover components, `apps/app/src/app/api/v1/plugin/catalog/*`.
**Docs** — new `apps/docs/content/docs/plugins/registries.mdx`.

---

### Task 1: Schema clean-rebuild (Drizzle)

**Files:**
- Modify: `packages/database/src/schema/mcp.ts` — drop `mcpCatalogServers`; on `mcpRegistries` add `workspaceId` (NOT NULL), add `isDefault` boolean, remove `isDefaultSeed`/`lastSyncedAt`/`lastSyncedCursor`; unique `(org_id, workspace_id, base_url)`; keep `mcpCredentials`, `mcpServers`.
- Modify: `packages/database/src/schema/plugin.ts` — rename `pluginOrgListings`→`pluginInstalledPlugins` (table `installed_plugins`), `workspaceId` NOT NULL, drop `catalogServerId`, retype `PLUGIN_TYPES` to the 5 + CHECK; delete `pluginOrgDenylist`.
- Modify: `packages/database/src/schema/index.ts` + `packages/database/src/index.ts` — fix exports.
- Test: `packages/database/src/__tests__/plugin-schema.test.ts` (update), delete `__tests__/seed-mcp-catalog.test.ts`.

**Interfaces — Produces:**
- `export const PLUGIN_TYPES = ["agent_skill","agent_capability","mcp_server","knowledge_source","integration"] as const;`
- `mcpRegistries` columns incl. `workspaceId: uuid("workspace_id").notNull()`, `isDefault: boolean("is_default").notNull().default(false)`.
- `pluginInstalledPlugins` with `workspaceId: uuid("workspace_id").notNull()`, no `catalogServerId`.

- [ ] Step 1: Update `PLUGIN_TYPES` + CHECK in `plugin.ts`; rename table to `installed_plugins`, make `workspace_id` NOT NULL, drop `catalog_server_id`, delete `pluginOrgDenylist`.
- [ ] Step 2: In `mcp.ts` delete `mcpCatalogServers`; add `workspace_id`/`is_default` to `mcpRegistries`, drop sync columns; add partial unique index `UNIQUE (org_id, workspace_id) WHERE is_default` and `UNIQUE (org_id, workspace_id, base_url)`.
- [ ] Step 3: Fix all schema barrel exports; grep `mcpCatalogServers|pluginOrgListings|pluginOrgDenylist|isDefaultSeed` repo-wide, list every consumer (input for later tasks).
- [ ] Step 4: Update `plugin-schema.test.ts` to assert the 5 types + new columns; delete obsolete catalog test. Run `pnpm --filter @oxagen/database test`.
- [ ] Step 5: Commit `feat(db): workspace-scope registries + installed_plugins, drop catalog/denylist`.

### Task 2: Atlas migration + RLS + grants

**Files:**
- Create: `packages/database/atlas/migrations/<ts>_marketplace_workspace_scope.sql` (drop `mcp.catalog_servers`, `plugin.org_denylist`; rebuild `mcp.registries` + `plugin.installed_plugins` workspace-scoped; CHECK = 5 types).
- Modify: `packages/database/src/tenant-policy.manifest.ts` — replace `org_listings` with `installed_plugins`, ensure `registries` workspace-scoped RLS; remove `org_denylist`/`catalog_servers`.
- Regen RLS policy migration via `gen-rls-migration.ts` → `atlas migrate hash`; add `oxagen_app` grants for renamed tables.

- [ ] Step 1: Write the forward SQL migration (clean rebuild). Echo target DB (`localhost:5433`) before applying.
- [ ] Step 2: Update tenant-policy manifest; regen RLS migration; `atlas migrate hash`.
- [ ] Step 3: `unset DATABASE_URL; pnpm db:migrate` locally; verify with `SELECT` that `mcp.catalog_servers`/`plugin.org_denylist` are gone and `installed_plugins.workspace_id` is NOT NULL.
- [ ] Step 4: `pnpm db:lint-migrations`. Commit.

### Task 3: Seeding — exactly one registry per workspace

**Files:**
- Modify: `packages/database/src/seed.ts` — fix `OFFICIAL_MCP_REGISTRY.baseUrl` to `https://registry.modelcontextprotocol.io` (no suffix); replace `ensureOfficialMcpRegistry` global-seed logic; delete the curated `catalog_servers` seed block.
- Create/Modify: workspace-creation seed (find the better-auth workspace-create hook / `workspace.create` handler) → insert exactly one default registry `(org_id, workspace_id, is_default=true)`, idempotent.
- Test: new `packages/handlers/src/__tests__/workspace-registry-seed.test.ts` — **creating a workspace yields exactly one registry, is_default=true**.

**Interfaces — Produces:** `seedWorkspaceDefaultRegistry(tx, { orgId, workspaceId }): Promise<string>` (returns registry id; idempotent select-then-insert on the `(org_id, workspace_id, base_url)` unique index).

- [ ] Step 1: Write the failing unit test asserting exactly-one-registry after workspace create.
- [ ] Step 2: Run it — expect FAIL.
- [ ] Step 3: Implement `seedWorkspaceDefaultRegistry`; wire into the workspace-create path; fix seed URL; delete catalog seed.
- [ ] Step 4: Run test — expect PASS. Run `pnpm --filter @oxagen/handlers test`.
- [ ] Step 5: Commit.

### Task 4: Single-default registry state machine

**Files:**
- Create: `packages/handlers/src/registry-default.ts` — pure logic + handler helpers.
- Modify: `packages/handlers/src/plugin.registry.add.ts`, `plugin.registry.remove.ts`, `plugin.registry.list.ts` (workspace scope).
- Test: `packages/handlers/src/__tests__/registry-default.test.ts`.

**Interfaces — Produces:**
- `addRegistry(tx, { orgId, workspaceId, name, baseUrl }) → { id, isDefault }` — forces `isDefault=true` iff zero exist for (org,ws), else false.
- `removeRegistry(tx, { orgId, workspaceId, registryId }) → { promotedId: string | null }` — removing the default promotes the most-recently-added remaining row (by `created_at desc`) atomically; allowed even for the default; if none remain, `promotedId=null`.
- Invariant: with exactly 1 registry it is default and immutable (no API to toggle default; there is no `set_default`).

- [ ] Step 1: Write failing tests for every transition (add-to-empty→default; add-to-nonempty→non-default; remove-default-with-others→promote most-recent; remove-default-alone→ok; remove-non-default→no promotion; exactly-1 is default).
- [ ] Step 2: Run — expect FAIL.
- [ ] Step 3: Implement `registry-default.ts`; rewrite add/remove/list handlers to workspace scope and call it (remove the old `isDefaultSeed=false` removal guard so the default IS removable).
- [ ] Step 4: Run — expect PASS.
- [ ] Step 5: Commit.

### Task 5: Live browse (remove sync reads) + workspace scope + drop denylist

**Files:**
- Modify: `packages/handlers/src/plugin.catalog.browse.ts` — replace `mcpCatalogServers` queries with a live read over the workspace's enabled registries via `@oxagen/plugins` `registry-client.ts` + `map-server.ts`; merge static `agent_capability`/`agent_skill` packs; overlay install state from `installed_plugins`; remove all denylist logic; workspace-scoped.
- Modify: `packages/handlers/src/plugin.catalog.get.ts` — live single-server fetch.
- Add: short TTL server cache helper (runtime cache, ~60s) keyed by (registryId, query).
- Test: `packages/handlers/src/__tests__/plugin.catalog.browse.test.ts` — mock `registry-client`; assert live merge + install overlay + workspace scoping + the 5 types.

**Interfaces — Consumes:** `listRegistriesForWorkspace`, `registry-client.listServers(baseUrl, query)`, `mapServer()`. **Produces:** browse output shape unchanged except `pluginType` ∈ 5 and no `tier`-gated denylist fields.

- [ ] Step 1: Write failing test (mocked client) for live browse + overlay.
- [ ] Step 2: Run — FAIL.
- [ ] Step 3: Implement live read + cache; delete denylist branches.
- [ ] Step 4: Run — PASS. Commit.

### Task 6: Delete sync end-to-end

**Files (delete):** `packages/plugins/src/registry/sync-service.ts` (+ test), `packages/oxagen/src/contracts/plugin.registry.sync.ts`, `apps/api/src/routes/v1/plugin.registry.sync.ts`, `apps/mcp/src/tools/plugin.registry.sync.ts`, `apps/cli/src/commands/plugin.registry.sync.ts`.
**Modify:** `packages/handlers/src/organization.create.ts` (remove the `plugin/registry.sync` fire-and-forget trigger + unused imports), `apps/api/src/app.ts` (remove `/plugin/registries/sync` route mount), any cron registration for `plugin/registry.sync`, the contracts barrel, `packages/plugins/src/registry/index.ts`.

- [ ] Step 1: Delete the sync files; remove route mount + cron + org-create trigger.
- [ ] Step 2: Grep `registry.sync|registrySync|registry/sync` repo-wide → zero non-test references; update/remove their tests.
- [ ] Step 3: `pnpm check:manifest` — confirm sync capability gone cleanly; `pnpm typecheck`. Commit.

### Task 7: Re-scope contracts + fix IDOR + drop denylist contracts

**Files:**
- Modify all `packages/oxagen/src/contracts/plugin.*` that were `scoped:false` → workspace `scoped:true` (registry.*, catalog.*, install/uninstall/list, set_enabled). Delete `plugin.denylist.add/remove` contracts.
- Modify `packages/handlers/src/plugin.workspace.set_enabled.ts` (and install/list handlers) — validate `workspaceId` against the request scope (fix IDOR); remove org-preapproval gating so any workspace installs anything.
- Update `docs/capabilities/*` for renamed/removed caps.

- [ ] Step 1: Flip contract scope; delete denylist contracts; update handler scope checks + IDOR fix.
- [ ] Step 2: Update contract tests + `route-contract-parity` expectations.
- [ ] Step 3: `pnpm check:contracts` + `pnpm check:manifest`. Commit.

### Task 8: Seed capability + skill packs; retire "Oxagen Plugin" naming

**Files:**
- Modify: `packages/oxagen/src/plugins/manifest.ts`/`registry.ts` + `catalog/*/manifest.ts` — set `pluginType:"agent_capability"` for media-* + documents; rename any "Oxagen Plugin" wording to "capability pack"/the 5-type vocabulary in code/types/comments.
- Modify seed: seed `agent_capability` packs as **disabled** `installed_plugins` rows per workspace; seed `agent_skill` packs (the agent skills already seeded via `db:seed-skills`) as **enabled** `agent_skill` installed_plugins rows.
- Modify `apps/docs/content/docs/plugins/oxagen-plugins.mdx` naming; update `.agents/skills/oxagen-plugins` references if surfaced to users.
- Test: seed produces disabled capabilities + enabled skills; entitlement gate still blocks an uninstalled capability.

- [ ] Step 1: Write failing test (seed → capability disabled, skill enabled; kernel gate blocks uninstalled capability).
- [ ] Step 2: Run — FAIL. Step 3: Implement seeding + renames. Step 4: Run — PASS. Step 5: Commit.

### Task 9: API / MCP / CLI parity sweep

**Files:** `apps/api/src/routes/v1/plugin.*` + `app.ts`, `apps/mcp/src/tools/plugin.*`, `apps/cli/src/commands/plugin.*` — workspace scope in path/params; remove sync + denylist route/tool/command; align with new contracts.

- [ ] Step 1: Update routes/tools/commands; remove deleted capabilities; ensure `/{org}/{workspace}` scoping is enforced (not just present).
- [ ] Step 2: Update `apps/api/src/__tests__/routes.plugin.test.ts` + MCP/CLI tests.
- [ ] Step 3: `pnpm check:manifest` green; `pnpm typecheck`. Commit.

### Task 10: Fix Base UI tabs (data-attribute)

**Files:** `packages/ui/src/components/tabs.tsx`, `packages/ui/src/components/tabs.test.tsx`.

**Root cause:** selected-state classes use `data-[selected]:` but Base UI here emits `data-active` (memory `ui-base-ui-stock-shadcn`). Verify the actual emitted attribute against `@base-ui/react/tabs` in `node_modules` before editing.

- [ ] Step 1: Write/extend a failing RTL test: clicking a `TabsTab` sets the active styling/attribute and switches the visible `TabsPanel`.
- [ ] Step 2: Run — FAIL.
- [ ] Step 3: Replace `data-[selected]:` with the correct attribute (`data-[active]:` if confirmed) across `TabsTab`; verify `TabsIndicator` reads the Base UI `--active-tab-*` vars; keep the motion fade.
- [ ] Step 4: Run — PASS; `pnpm --filter @oxagen/ui test`. Commit.

### Task 11: Marketplace modal — 5 types, no Oxagen-Plugin/content_tool tab, live data, no denylist

**Files:** `apps/app/src/components/plugins/marketplace-modal.tsx`, `plugin-detail-panel.tsx`, `apps/app/src/app/api/v1/plugin/catalog/browse/route.ts` + `get/route.ts`.

- [ ] Step 1: Replace `PLUGIN_TABS` with the marketplace-surfaced types (`mcp_server`, `integration`, `agent_capability`, `agent_skill`, `knowledge_source`); remove the "Oxagen Plugins" + "Content Tools" tabs and all `content_tool`/`capability`(old) literals; retype `pluginType` to the 5.
- [ ] Step 2: Remove `deniedNames`/"blocked by your admins" treatment; pass `workspaceId` scope through; ensure each `TabsPanel` shows its own type's data (current code shares one `servers` array — fetch per active type is fine since tabs are mutually exclusive, but clear `servers` on tab change to avoid flashing the previous type).
- [ ] Step 3: Update component tests; `pnpm --filter app test`. Commit.

### Task 12: Move settings page to workspace + registry self-service UI + help popover

**Files:** delete `apps/app/src/app/[orgSlug]/settings/plugins/*` (page, org-plugins-panel, plugin-actions); finish `apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/plugins/*` (workspace-plugins-panel, plugin-actions, plugin-shape); new `registry-manager.tsx` + `registry-help-popover.tsx`; update sidebar marketplace entry to workspace route.

- [ ] Step 1: Build registry manager: list registries, Add (name+URL), Remove (incl. default with promotion confirmation), enforce single-default (no toggle when count ≤ 1; show "Default" badge, immutable at 1).
- [ ] Step 2: Help popover beside Add: explains a registry, real example `https://registry.modelcontextprotocol.io`, links `${process.env.NEXT_PUBLIC??NEXT_APP_DOCS_URL}/plugins/registries`. Use `@/components/ui/popover`.
- [ ] Step 3: Delete org-level page; repoint sidebar + any links to `[orgSlug]/[workspaceSlug]/settings/plugins`.
- [ ] Step 4: Component tests. Commit.

### Task 13: Docs page for registries

**Files:** `apps/docs/content/docs/plugins/registries.mdx` (+ `_index`/meta). Live examples (official MCP registry), how to add/remove, single-default rule. Path must match the app's `NEXT_APP_DOCS_URL` link.

- [ ] Step 1: Write the MDX page with real examples. Step 2: `pnpm --filter docs build`. Commit.

### Task 14: E2E + full gate + judge

**Files:** `apps/app/e2e/oxagen-plugins-marketplace.spec.ts` (rewrite expectations), new registry-management e2e; screenshots to `apps/app/e2e/screenshots/` (gitignored, recreated each run).

- [ ] Step 1: E2E: new workspace → marketplace lists live MCP servers; add/remove registry incl. default-promotion; install + use a plugin; tabs switch+animate (screenshot).
- [ ] Step 2: Bump coverage ratchets per policy (≤ floor(cov−2.5), cap 90).
- [ ] Step 3: `pnpm gate` green; dispatch **test-completeness-judge** until APPROVED.
- [ ] Step 4: Final commit; push to `main`; `gh run watch` until green (ci-green skill).

---

### Self-review notes
- Spec coverage: §3.1 schema→T1/T2; dup-bug+seed→T3; state machine→T4; live reads→T5; sync removal→T6; scope+IDOR+denylist→T7; capability/skill seeding + naming→T8; parity→T9; tabs→T10; modal→T11; page move+registry UI+help→T12; docs→T13; tests→T14. All sections mapped.
- Ordering: T1→T2→T3 (DB foundation) must precede backend T4–T8; T9 after contracts (T7); UI T10 independent (can run parallel with backend); T11 needs T5/T7; T12 needs T4 handlers; T13 independent; T14 last.
- Parallelizable safely (≤3 at a time, honoring the memory ceiling): \{T10 tabs} ∥ \{T13 docs} ∥ one backend task. Everything in the DB chain (T1→T2→T3) is strictly serial.

