# Marketplace Workspace-Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax. Each task is dispatched to a Sonnet worker; Opus advisor reviews between tasks.

**Goal:** Re-scope the entire plugin/marketplace system from org to org+workspace, replace registry "sync" with live HTTP reads, collapse to a 5-type plugin taxonomy, fix the broken Base UI tabs, and ship workspace-level registry self-service with a single-default rule.

**Architecture:** Postgres schema clean-rebuild (workspace-scoped `mcp.registries` + `plugin.installed_plugins`; drop `mcp.catalog_servers` + `plugin.org_denylist`). Browse reads registries live via the existing `registry-client.ts` with a short server-side TTL cache. Capability/skill packs come from the static `@oxagen/oxagen/plugins` registry, gated by the kernel entitlement service. All contracts/routes/MCP tools move to workspace scope in lockstep.

**Tech Stack:** Drizzle + Atlas (Postgres), Hono (API), xmcp (MCP), Next.js 16 App Router + Base UI (`@oxagen/ui`), Vitest + Playwright.

## Global Constraints (verbatim from spec + CLAUDE.md / engineering policy)
- Pre-launch, no live customers → **clean rebuild**, drop+recreate plugin/registry tables. Commit to `main` after `pnpm gate`.
- Plugin types are exactly 5: `agent_skill`, `agent_capability`, `mcp_server`, `knowledge_source`, `integration`.
- Seeded `agent_skill` packs install **enabled**; seeded `agent_capability` packs install **disabled** (marketplace-visible).
- No `any`; strict types; zero lint warnings (`--max-warnings 0`); pinned deps. New code requires new tests.
- Coverage thresholds are ratchets capped at 90; bump only to `floor(coverage − 2.5)`, never lower.
- UI imports from `@/components/ui/<name>`, never `@oxagen/ui/components/*` directly (except the re-export files).
- Migration files in `packages/database/` only. RLS manifest + `oxagen_app` grants replayed as Atlas migrations.
- Capability parity: contract → API route → MCP tool together; `pnpm check:manifest` stays green.
- Docs link uses `NEXT_APP_DOCS_URL` env var; help copy follows brand-voice policy.

---

## File Structure (what changes)

**Schema/DB** — `packages/database/src/schema/mcp.ts`, `.../plugin.ts`, `.../index.ts`, `src/seed.ts`, `src/tenant-policy.manifest.ts`, new Atlas migration under `packages/database/atlas/migrations/`.
**Backend** — `packages/handlers/src/plugin.*` (browse, install, list, registry.add/remove/list, set_enabled), new `packages/handlers/src/registry-default.ts` (state machine), `packages/handlers/src/organization.create.ts` (drop sync trigger), `packages/plugins/src/registry/` (drop sync-service, keep client/map-server), `packages/oxagen/src/contracts/plugin.*`, `packages/oxagen/src/plugins/*` (rename concept), seed scripts.
**Surfaces** — `apps/api/src/routes/v1/plugin.*` + `app.ts`, `apps/mcp/src/tools/plugin.*`.
**UI** — `packages/ui/src/components/tabs.tsx` (data-attr fix), `apps/app/src/components/plugins/marketplace-modal.tsx`, `.../plugin-detail-panel.tsx`, `apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/plugins/*`, delete `apps/app/src/app/[orgSlug]/settings/plugins/*`, new registry-management + help-popover components, `apps/app/src/app/api/v1/plugin/catalog/*`.
**Docs** — new `apps/docs/content/docs/plugins/registries.mdx`.

---

## Task 1: Schema clean-rebuild (Drizzle)

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

## Task 2: Atlas migration + RLS + grants

**Files:**
- Create: `packages/database/atlas/migrations/<ts>_marketplace_workspace_scope.sql` (drop `mcp.catalog_servers`, `plugin.org_denylist`; rebuild `mcp.registries` + `plugin.installed_plugins` workspace-scoped; CHECK = 5 types).
- Modify: `packages/database/src/tenant-policy.manifest.ts` — replace `org_listings` with `installed_plugins`, ensure `registries` workspace-scoped RLS; remove `org_denylist`/`catalog_servers`.
- Regen RLS policy migration via `gen-rls-migration.ts` → `atlas migrate hash`; add `oxagen_app` grants for renamed tables.

- [ ] Step 1: Write the forward SQL migration (clean rebuild). Echo target DB (`localhost:5433`) before applying.
- [ ] Step 2: Update tenant-policy manifest; regen RLS migration; `atlas migrate hash`.
- [ ] Step 3: `unset DATABASE_URL; pnpm db:migrate` locally; verify with `SELECT` that `mcp.catalog_servers`/`plugin.org_denylist` are gone and `installed_plugins.workspace_id` is NOT NULL.
- [ ] Step 4: `pnpm db:lint-migrations`. Commit.

## Task 3: Seeding — exactly one registry per workspace

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

## Task 4: Single-default registry state machine

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

## Task 5: Live browse (remove sync reads) + workspace scope + drop denylist

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

## Task 6: Delete sync end-to-end

**Files (delete):** `packages/plugins/src/registry/sync-service.ts` (+ test), `packages/oxagen/src/contracts/plugin.registry.sync.ts`, `apps/api/src/routes/v1/plugin.registry.sync.ts`, `apps/mcp/src/tools/plugin.registry.sync.ts`.
**Modify:** `packages/handlers/src/organization.create.ts` (remove the `plugin/registry.sync` fire-and-forget trigger + unused imports), `apps/api/src/app.ts` (remove `/plugin/registries/sync` route mount), any cron registration for `plugin/registry.sync`, the contracts barrel, `packages/plugins/src/registry/index.ts`.

- [ ] Step 1: Delete the sync files; remove route mount + cron + org-create trigger.
- [ ] Step 2: Grep `registry.sync|registrySync|registry/sync` repo-wide → zero non-test references; update/remove their tests.
- [ ] Step 3: `pnpm check:manifest` — confirm sync capability gone cleanly; `pnpm typecheck`. Commit.

## Task 7: Re-scope contracts + fix IDOR + drop denylist contracts

**Files:**
- Modify all `packages/oxagen/src/contracts/plugin.*` that were `scoped:false` → workspace `scoped:true` (registry.*, catalog.*, install/uninstall/list, set_enabled). Delete `plugin.denylist.add/remove` contracts.
- Modify `packages/handlers/src/plugin.workspace.set_enabled.ts` (and install/list handlers) — validate `workspaceId` against the request scope (fix IDOR); remove org-preapproval gating so any workspace installs anything.
- Update `docs/capabilities/*` for renamed/removed caps.

- [ ] Step 1: Flip contract scope; delete denylist contracts; update handler scope checks + IDOR fix.
- [ ] Step 2: Update contract tests + `route-contract-parity` expectations.
- [ ] Step 3: `pnpm check:contracts` + `pnpm check:manifest`. Commit.

## Task 8: Seed capability + skill packs; retire "Oxagen Plugin" naming

**Files:**
- Modify: `packages/oxagen/src/plugins/manifest.ts`/`registry.ts` + `catalog/*/manifest.ts` — set `pluginType:"agent_capability"` for media-* + documents; rename any "Oxagen Plugin" wording to "capability pack"/the 5-type vocabulary in code/types/comments.
- Modify seed: seed `agent_capability` packs as **disabled** `installed_plugins` rows per workspace; seed `agent_skill` packs (the agent skills already seeded via `db:seed-skills`) as **enabled** `agent_skill` installed_plugins rows.
- Modify `apps/docs/content/docs/plugins/oxagen-plugins.mdx` naming; update `.agents/skills/oxagen-plugins` references if surfaced to users.
- Test: seed produces disabled capabilities + enabled skills; entitlement gate still blocks an uninstalled capability.

- [ ] Step 1: Write failing test (seed → capability disabled, skill enabled; kernel gate blocks uninstalled capability).
- [ ] Step 2: Run — FAIL. Step 3: Implement seeding + renames. Step 4: Run — PASS. Step 5: Commit.

## Task 9: API / MCP parity sweep

**Files:** `apps/api/src/routes/v1/plugin.*` + `app.ts`, `apps/mcp/src/tools/plugin.*` — workspace scope in path/params; remove sync + denylist route/tool; align with new contracts.

- [ ] Step 1: Update routes/tools; remove deleted capabilities; ensure `/{org}/{workspace}` scoping is enforced (not just present).
- [ ] Step 2: Update `apps/api/src/__tests__/routes.plugin.test.ts` + MCP tests.
- [ ] Step 3: `pnpm check:manifest` green; `pnpm typecheck`. Commit.

## Task 10: Fix Base UI tabs (data-attribute)

**Files:** `packages/ui/src/components/tabs.tsx`, `packages/ui/src/components/tabs.test.tsx`.

**Root cause:** selected-state classes use `data-[selected]:` but Base UI here emits `data-active` (memory `ui-base-ui-stock-shadcn`). Verify the actual emitted attribute against `@base-ui/react/tabs` in `node_modules` before editing.

- [ ] Step 1: Write/extend a failing RTL test: clicking a `TabsTab` sets the active styling/attribute and switches the visible `TabsPanel`.
- [ ] Step 2: Run — FAIL.
- [ ] Step 3: Replace `data-[selected]:` with the correct attribute (`data-[active]:` if confirmed) across `TabsTab`; verify `TabsIndicator` reads the Base UI `--active-tab-*` vars; keep the motion fade.
- [ ] Step 4: Run — PASS; `pnpm --filter @oxagen/ui test`. Commit.

## Task 11: Marketplace modal — 5 types, no Oxagen-Plugin/content_tool tab, live data, no denylist

**Files:** `apps/app/src/components/plugins/marketplace-modal.tsx`, `plugin-detail-panel.tsx`, `apps/app/src/app/api/v1/plugin/catalog/browse/route.ts` + `get/route.ts`.

- [ ] Step 1: Replace `PLUGIN_TABS` with the marketplace-surfaced types (`mcp_server`, `integration`, `agent_capability`, `agent_skill`, `knowledge_source`); remove the "Oxagen Plugins" + "Content Tools" tabs and all `content_tool`/`capability`(old) literals; retype `pluginType` to the 5.
- [ ] Step 2: Remove `deniedNames`/"blocked by your admins" treatment; pass `workspaceId` scope through; ensure each `TabsPanel` shows its own type's data (current code shares one `servers` array — fetch per active type is fine since tabs are mutually exclusive, but clear `servers` on tab change to avoid flashing the previous type).
- [ ] Step 3: Update component tests; `pnpm --filter app test`. Commit.

## Task 12: Move settings page to workspace + registry self-service UI + help popover

**Files:** delete `apps/app/src/app/[orgSlug]/settings/plugins/*` (page, org-plugins-panel, plugin-actions); finish `apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/plugins/*` (workspace-plugins-panel, plugin-actions, plugin-shape); new `registry-manager.tsx` + `registry-help-popover.tsx`; update sidebar marketplace entry to workspace route.

- [ ] Step 1: Build registry manager: list registries, Add (name+URL), Remove (incl. default with promotion confirmation), enforce single-default (no toggle when count ≤ 1; show "Default" badge, immutable at 1).
- [ ] Step 2: Help popover beside Add: explains a registry, real example `https://registry.modelcontextprotocol.io`, links `${process.env.NEXT_PUBLIC??NEXT_APP_DOCS_URL}/plugins/registries`. Use `@/components/ui/popover`.
- [ ] Step 3: Delete org-level page; repoint sidebar + any links to `[orgSlug]/[workspaceSlug]/settings/plugins`.
- [ ] Step 4: Component tests. Commit.

## Task 13: Docs page for registries

**Files:** `apps/docs/content/docs/plugins/registries.mdx` (+ `_index`/meta). Live examples (official MCP registry), how to add/remove, single-default rule. Path must match the app's `NEXT_APP_DOCS_URL` link.

- [ ] Step 1: Write the MDX page with real examples. Step 2: `pnpm --filter docs build`. Commit.

## Task 14: E2E + full gate + judge

**Files:** `apps/app/e2e/oxagen-plugins-marketplace.spec.ts` (rewrite expectations), new registry-management e2e; screenshots to `apps/app/e2e/screenshots/` (gitignored, recreated each run).

- [ ] Step 1: E2E: new workspace → marketplace lists live MCP servers; add/remove registry incl. default-promotion; install + use a plugin; tabs switch+animate (screenshot).
- [ ] Step 2: Bump coverage ratchets per policy (≤ floor(cov−2.5), cap 90).
- [ ] Step 3: `pnpm gate` green; dispatch **test-completeness-judge** until APPROVED.
- [ ] Step 4: Final commit; push to `main`; `gh run watch` until green (ci-green skill).

---

## Self-review notes
- Spec coverage: §3.1 schema→T1/T2; dup-bug+seed→T3; state machine→T4; live reads→T5; sync removal→T6; scope+IDOR+denylist→T7; capability/skill seeding + naming→T8; parity→T9; tabs→T10; modal→T11; page move+registry UI+help→T12; docs→T13; tests→T14. All sections mapped.
- Ordering: T1→T2→T3 (DB foundation) must precede backend T4–T8; T9 after contracts (T7); UI T10 independent (can run parallel with backend); T11 needs T5/T7; T12 needs T4 handlers; T13 independent; T14 last.
- Parallelizable safely (≤3 at a time, honoring the memory ceiling): {T10 tabs} ∥ {T13 docs} ∥ one backend task. Everything in the DB chain (T1→T2→T3) is strictly serial.
