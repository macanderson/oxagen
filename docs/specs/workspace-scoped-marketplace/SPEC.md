# Marketplace / Plugins — Workspace Scoping + Registry Simplification

**Date:** 2026-06-17
**Status:** DECISIONS RESOLVED (§7) — awaiting user approval of spec before implementation plan
**Author:** Claude (Opus 4.8) with Mac Anderson

---

## 1. Goal (in the user's words)

Re-scope the entire marketplace/plugin system from **org** to **org + workspace**, delete the
registry "sync" machinery in favor of **live HTTP reads**, collapse the "Oxagen Plugin"
abstraction into a flat **five-type plugin taxonomy**, fix the **broken marketplace tabs**, and give
workspaces **self-service registry management** (add/remove, with an enforced single-default rule)
plus an **in-context help popover** that links to docs.

End state: create a new workspace → click Marketplace in the sidebar → immediately see **all** MCP
servers from the seeded registry, fetched live. No sync. No org pre-approval. No "Oxagen Plugin" tab.

---

## 2. Current state (discovery findings)

### 2.1 Data model (`packages/database/src/schema/`)
- `mcp.registries` — `org_id` (NULL ⇒ global seed), `name`, `base_url`, `enabled`, **`is_default_seed`**,
  **`last_synced_at`**, **`last_synced_cursor`**. **No `workspace_id`.** Unique on `COALESCE(org_id) + base_url`.
- `mcp.catalog_servers` — **the synced cache of installable MCP servers.** ← to be **DROPPED**.
- `mcp.credentials` — encrypted auth per (org_listing × workspace). `orgScopeMixin` (org+workspace). **Keep.**
- `mcp.mcp_servers` — installed server instances per org/workspace. `orgScopeMixin`. Links `org_listing_id`. **Keep.**
- `plugin.org_listings` — the install record. `org_id NOT NULL`, **`workspace_id` (nullable, recently added)**,
  `plugin_type` ∈ {`mcp_server`,`integration`,`content_tool`,`capability`}, `catalog_server_id` (FK → dropped table),
  `source` ∈ {registry,custom,oxagen}, denormalized identity (`name/title/description/icon_url/endpoint_url/transport/auth_kind`),
  `enabled` (default **false**), soft-delete. **Re-scope + retype.**
- `plugin.org_denylist` — org admin blocklist ("blocked by your organization's admins"). ← the org-preapproval mechanism.

### 2.2 The duplicate-registry bug (root-caused)
- Migrations `20260614…seed_official_mcp_registry.sql` + `0000_baseline.sql` seed `base_url='https://registry.modelcontextprotocol.io'` (no path).
- `seed.ts` `OFFICIAL_MCP_REGISTRY.baseUrl='https://registry.modelcontextprotocol.io/v0.1/servers'` (**with** path).
- `registry-client.ts` **appends** `/v0.1/servers`, so the correct stored value has **no** suffix; the seed.ts constant is wrong.
- `ensureOfficialMcpRegistry()` guards its insert by matching on `base_url` → never matches the migration's row →
  **inserts a second NULL-org default-seed row** with a different URL. Migration `20260615…workspace_plugin_scope.sql`
  bolts on an after-the-fact `UPDATE … SET base_url=… WHERE base_url LIKE '%/v0.1/servers%'` cleanup. **This is the bug.**

### 2.3 Sync machinery (to delete)
`mcp.catalog_servers` ← `packages/plugins/src/registry/sync-service.ts` ← `plugin.registry.sync`
(contract + API route `/plugin/registries/sync` + MCP tool) ← `organization.create.ts` fire-and-forget
trigger (`eventClient.send("plugin/registry.sync")`) ← a 6-hour cron. Browse reads the synced table.

### 2.4 Capability packs = "Oxagen Plugins" (to rename, not delete)
`packages/oxagen/src/plugins/registry.ts` builds a static registry of 4 manifests:
`oxagen/media-video`, `oxagen/media-image`, `oxagen/media-svg`, `oxagen/documents` — each claims a contract
(`svg.generate`, etc.), `tier`, `visibility`, `category:"media"`. The **kernel entitlement gate**
(`packages/plugins/src/entitlements/entitlement-service.ts`) blocks claimed contracts until installed+enabled in
`plugin.org_listings`. These are exactly the user's **`agent_capability`** plugins (seeded **uninstalled**).

### 2.5 The broken tabs
`apps/app/src/components/plugins/marketplace-modal.tsx` wires Base UI Tabs correctly (`value`/`onValueChange`,
`TabsTab value=`, `TabsPanel value=`). The bug is in `packages/ui/src/components/tabs.tsx`: selected-state classes use
**`data-[selected]:`** but Base UI in this repo emits **`data-active`** (per memory `ui-base-ui-stock-shadcn`). State
flips on click but no class responds → no highlight, no panel change, no indicator move. **One-component fix, repo-wide benefit.**

### 2.6 Surface inventory (parity must move in lockstep)
17 org-scoped + 1 workspace-scoped contract/route/MCP-tool triples under `plugin.*`. Latent IDOR found:
`plugin.workspace.set_enabled` accepts a body `workspaceId` never validated against the API-key's bound workspace.

### 2.7 Partially-started migration (important)
Route folders **both** exist: `[orgSlug]/settings/plugins/` (org-plugins-panel) and
`[orgSlug]/[workspaceSlug]/settings/plugins/` (workspace-plugins-panel). `org_listings.workspace_id` already added
(nullable). So this is a **half-done migration to finish + correct**, not greenfield.

---

## 3. Target architecture

### 3.1 Data model (after)
**`mcp.registries`** — add `workspace_id UUID NOT NULL`; **drop** `is_default_seed`, `last_synced_at`, `last_synced_cursor`;
add `is_default BOOLEAN NOT NULL` (per-workspace, exactly-one-true invariant). Unique `(org_id, workspace_id, base_url)`.
Every registry row is concrete and owned by one workspace (removable).

**`plugin.org_listings` → `plugin.installed_plugins`** (renamed): `workspace_id NOT NULL`, `plugin_type` ∈ the new 5,
**drop** `catalog_server_id` (identity already denormalized on the row; live data via HTTP).

**DROP:** `mcp.catalog_servers`, `plugin.org_denylist`.

**Plugin types (5):** `agent_skill`, `agent_capability`, `mcp_server`, `knowledge_source`, `integration`.
Mapping: `capability`→`agent_capability`; `content_tool`→`agent_capability`; **new:** `agent_skill`, `knowledge_source`.

### 3.2 Live registry reads (no sync)
Browse calls `registry-client.ts` against each enabled workspace registry's `base_url` (live), merges results, overlays
install state from `installed_plugins`, and overlays the static `agent_capability`/`agent_skill` packs. A short-TTL
**server-side request cache** (runtime cache, ~60s) prevents hammering the upstream on keystrokes — this is a transient
cache, **not** a synced table, so it honors "no sync."

### 3.3 Single-default registry state machine (one enforced rule, in one handler)
- 0 registries → fine.
- Adding when 0 exist → new row forced `is_default=true`.
- Adding when ≥1 exists → new row `is_default=false`.
- Exactly 1 registry → it is `is_default=true`, **immutable** (UI shows no toggle).
- Remove default with others present → **most-recently-added** remaining row promoted to default (atomic).
- Remove default with none remaining → fine.
- No user-facing "make default" toggle ever. Invariant enforced in the handler + a DB partial unique index
  (`UNIQUE (org_id, workspace_id) WHERE is_default`).

### 3.4 Seeding (idempotent, exactly-one)
On **workspace** creation, insert exactly one registry: `(org_id, workspace_id, name='Official MCP Registry',
base_url='https://registry.modelcontextprotocol.io', is_default=true)`. Guarded by the `(org_id, workspace_id, base_url)`
unique index + select-then-insert. Fix the `seed.ts` URL constant (drop the `/v0.1/servers` suffix). Remove the
org-create sync trigger. **New unit test:** creating a workspace yields exactly one registry.

### 3.5 UI
- **Move** the page to `[orgSlug]/[workspaceSlug]/settings/plugins`; retire the org-level page/panel.
- **Marketplace modal:** remove the "Oxagen Plugins" (`capability`) **tab** and the `content_tool` tab; tabs become the
  installable kinds the marketplace surfaces. Remove "blocked by your organization's admins" denylist UI.
- **Fix tabs** in `packages/ui` (data-attribute).
- **Registry management UI** (in workspace settings/plugins): list registries, add, remove (incl. default with promotion),
  with the single-default rule enforced visually (no toggle when count ≤ 1).
- **Help popover** beside the "Add registry" control: explains what a registry URL is, shows real examples
  (e.g. `https://registry.modelcontextprotocol.io`), and links to `${NEXT_APP_DOCS_URL}/<path>` — a new docs page.

### 3.6 Capability parity
Every changed capability moves contract → API route → MCP tool together. Delete `plugin.registry.sync` across all
four. Fix the `plugin.workspace.set_enabled` IDOR while we're rewriting the scope gate. `pnpm check:manifest` stays green.

---

## 4. Test plan
- **Unit:** single-default state machine (all transitions); exactly-one-registry-on-workspace-create; seed URL correctness;
  browse live-merge + install overlay; entitlement gate still blocks uninstalled `agent_capability`.
- **Contract/route parity:** updated `route-contract-parity` + per-route tests; sync routes removed.
- **E2E:** new workspace → marketplace shows live MCP servers; add/remove registry incl. default-promotion; install a
  plugin and use it; tabs switch + animate (screenshots to `apps/app/e2e/screenshots/`).
- Coverage ratchets bumped (never lowered), per policy.

## 5. Migration strategy
Pre-launch, no live customers (CLAUDE.md) → **clean rebuild** (§7-A). Forward Atlas migration in `packages/database/`:
drop `mcp.catalog_servers` + `plugin.org_denylist`; rename `plugin.org_listings`→`plugin.installed_plugins` with
`workspace_id NOT NULL`; add `registries.workspace_id` (NOT NULL) + `is_default`, drop `is_default_seed`/`last_synced_*`;
retype `plugin_type` CHECK to the 5. RLS manifest + `oxagen_app` grants updated for renamed/changed tables (replay as
Atlas migrations so a re-baseline can't drop them — memory: prod-outage postmortem).

## 6. Risks
- **Kernel entitlement gate** must keep gating `agent_capability` packs after re-scope — covered by tests.
- **Live upstream latency/availability** — short TTL cache + graceful empty-state on registry fetch failure.
- **Atlas re-baseline loses non-Drizzle DDL** (RLS/grants) — replay as Atlas migrations (memory: prod-outage postmortem).

---

## 7. DECISIONS (RESOLVED 2026-06-17)

- **A. Data migration → CLEAN REBUILD.** Drop + recreate plugin/registry tables fresh in the new workspace-scoped
  shape. No backfill, no nullable legacy rows. Workspaces re-seed their default registry on creation.
- **B. `content_tool` → FOLD INTO `agent_capability`.** Any `content_tool` row/type becomes `agent_capability`; the
  `content_tool` type is removed from the CHECK and from all code.
- **C. `plugin.org_denylist` → DROP ENTIRELY.** Delete the table, the denylist contracts/routes/MCP tools, and all
  "blocked by your organization's admins" UI. Pure workspace self-service — no org-level install gating.
- **D. Rename `plugin.org_listings` → `plugin.installed_plugins`.** Workspace-scoped install record; the old name is
  retired across schema, handlers, RLS manifest, and all references.

### Consequent invariants
- The only remaining org-vs-workspace gate is **tenancy** (RLS + scope checks), never "approval." Fix the
  `plugin.workspace.set_enabled` IDOR as part of the rewrite.
- The 5 `plugin_type` values are final: `agent_skill`, `agent_capability`, `mcp_server`, `knowledge_source`, `integration`.
- Seeded `agent_skill` packs install **enabled**; seeded `agent_capability` packs install **disabled** (uninstalled),
  surfaced in the marketplace for one-click enable.
