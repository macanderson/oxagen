# Oxagen Plugins — first-party capability packs (Phase 1)

Status: Phase 1 implemented (this branch) · Author: Claude (planner) + Mac Anderson · Date: 2026-06-12
Related: ADR-013, `docs/architecture/installable-plugins/specs/2026-06-06-installable-plugins-mcp-design.md`

## What an Oxagen Plugin is

An **Oxagen Plugin** is a first-party *capability pack*: a named, versioned bundle of
existing capability contracts that an org installs from the marketplace instead of
having always-on. Examples: `oxagen/media-video` (premium), `oxagen/media-svg` (free).
Capabilities not claimed by any plugin remain **builtin** — always available, no
install required. Phase 1 makes the four media/document-generation families
installable; everything else stays builtin.

Three phases:

- **Phase 1 (this branch):** manifest + static registry, `capability` plugin type,
  kernel entitlement gate, agent tool-list filter, marketplace browse/install/enable,
  typed `capability_not_installed` error, docs, tests.
- **Phase 2 (Linear):** monetization — plan-tier install gates, premium meter rates in
  `pricing.ts`, preview-allowlist visibility, workspace-level enable/disable,
  low-balance UX integration.
- **Phase 3 (Linear):** partner plugins — Postgres-mirrored manifest catalog,
  out-of-process execution protocol (context envelope + scoped graph tokens),
  manifest review flow, rev-share settlement on ClickHouse telemetry.

## Architecture invariants (binding)

1. **The kernel is the enforcement point.** Entitlement is checked in
   `kernel.invoke()` (packages/oxagen/src/kernel.ts), beside the billing gate, so
   API, MCP, and agent surfaces inherit it identically. Tool-list filtering in
   `materializeTools()` is UX, not security.
2. **One install model.** Capability packs reuse `plugin.org_listings`
   (plugin_type `capability`, source `oxagen`) and the existing
   install / set_enabled / uninstall / denylist contracts. No parallel tables.
3. **Manifests are pure data.** The manifest zod schema is DB-mirrorable by design —
   Phase 3 syncs partner manifests into Postgres; first-party manifests stay in-repo
   as the source of truth.
4. **Uninstall blocks new invocations only.** Running async jobs complete; generated
   assets persist (they are customer data, served via the assets route).
5. **Unclaimed contracts are builtin.** A contract may be claimed by at most one
   plugin (registry validation enforces this).

## Directory scaffold

```
packages/oxagen/src/plugins/
  manifest.ts            # OxagenPluginManifest zod schema + types (DB-mirrorable)
  registry.ts            # static registry: byId, pluginForContract(), validation
  index.ts               # barrel (exported from @oxagen/oxagen as ./plugins)
  catalog/
    media-video/manifest.ts
    media-image/manifest.ts
    media-svg/manifest.ts
    documents/manifest.ts
```

One directory per plugin: Phase 2/3 add per-plugin assets (icon, pricing, docs,
partner handler bindings) without restructuring.

### Manifest schema

```ts
{
  id: `oxagen/${slug}`,            // unique, stable
  name: string,                    // display name, e.g. "Video Generation"
  description: string,
  version: string,                 // semver; first-party is always-latest, recorded for the DB mirror
  tier: "free" | "premium",        // builtin packs do not exist — builtin = unclaimed
  visibility: "hidden" | "preview" | "beta" | "ga",
  category: string,                // marketplace grouping, e.g. "media"
  icon?: string,                   // lucide icon name
  contracts: [string, ...],        // capability names claimed by this pack
  minPlanTier?: "free"|"build"|"scale"|"enterprise",  // recorded now, ENFORCED in Phase 2
  scopes: string[],                // reserved for Phase 3 partner protocol; [] for first-party
}
```

### Phase 1 pack assignments

| Plugin id | Tier | Contracts |
|---|---|---|
| `oxagen/media-video` | premium | `video.generate` |
| `oxagen/media-image` | free | `image.generate`, `image.create`, `image.analyze`, `image.list` |
| `oxagen/media-svg` | free | `svg.generate` |
| `oxagen/documents` | free | `documents.generate`, `documents.pdf.create` |

`document.create/list/read` (workspace document CRUD) stay **builtin** — they are core
platform, distinct from the `documents.*` generation family.

## Enforcement design

- **Kernel slot** (mirrors `setBillingAdmissionGate`):
  `setCapabilityEntitlementGate(gate: (capabilityName: string, orgId: string) => Promise<void>)`.
  In `invoke()`, after the billing gate: if `pluginForContract(name)` returns a plugin
  (pure in-package lookup, no DB), call the gate. Unregistered gate ⇒ allow (matches
  IAM/billing default), but all three apps bootstrap it.
- **New error code:** `capability_not_installed` added to `CapabilityErrorCode`;
  message carries the plugin id + an install hint. Same shape on all surfaces.
- **Gate implementation** lives in `packages/plugins` (`src/entitlements/`): queries
  `plugin.org_listings` for `plugin_type='capability' AND enabled AND NOT deleted`,
  minus denylisted names; small TTL cache (30 s) keyed by orgId. Exports
  `listEntitledCapabilityPluginIds(orgId)` (used by the agent filter) and
  `bootstrapEntitlementRuntime()` (registered at the same call sites as
  `bootstrapBillingRuntime()` — apps/api, apps/mcp, apps/app).
- **Agent filter:** in `materializeTools()` first-party loop, skip contracts whose
  plugin is not in the org's entitled set (one fetch per materialization).
- **Org-level only in Phase 1.** Install ⇒ org listing `enabled=false` (same
  disabled-by-default governance as MCP servers); admin enables via
  `plugin.org.set_enabled`. Workspace-level enable is Phase 2.

## DB change (one Atlas migration)

Broaden two CHECK constraints on `plugin.org_listings`:
`plugin_type IN (… ,'capability')`, `source IN (… ,'oxagen')`. Update `PLUGIN_TYPES`
+ drizzle `check()` definitions in `packages/database/src/schema/plugin.ts`. No new
tables ⇒ no RLS-manifest change (org_listings is already `org_only`).

## Contract changes (no new contracts — parity preserved)

- `plugin.catalog.browse`: `pluginType` enum gains `capability`. When requested, the
  handler serves the **static registry** (not `mcp.catalog_servers`), mapped into the
  existing output shape (`authKind:'none'`, `transportTypes:[]`,
  `categories:[category]`), excluding `hidden`/`preview` visibility.
- `plugin.org.install`: enum gains `capability` + optional `pluginId` input; handler
  validates the id against the registry and inserts the listing
  (source `oxagen`, name = plugin id, title/description from manifest).
- `plugin.org.list`, `plugin.org.set_enabled`, `plugin.org.uninstall`,
  `plugin.denylist.*` operate on org_listings generically — verified + tested, not changed.
- `plugin.workspace.set_enabled` remains MCP-specific; rejects `capability` listings
  with a clear error until Phase 2.

## UI

Fourth tab in the marketplace modal (`PLUGIN_TABS`): **"Oxagen Plugins"** — entries
rendered from `plugin.catalog.browse` with `pluginType='capability'`, tier badge
(free/premium), install via the existing actions. Org settings plugins panel lists
capability rows like any listing. One Playwright e2e: open marketplace → Oxagen
Plugins tab → install → listing appears (disabled) → enable.

## Test plan

- packages/oxagen: manifest schema validation; registry invariants (duplicate
  contract claim throws, unknown contract name throws, id format); kernel gate
  (builtin bypass, refusal shape, unregistered-gate allow, error code).
- packages/plugins: entitlement service (entitled set assembly, denylist exclusion,
  TTL cache, soft-deleted exclusion).
- packages/handlers: browse capability source; install validation (bad pluginId,
  idempotent re-install).
- packages/agent: materialize filter (entitled vs not, builtin untouched).
- apps/app: e2e marketplace flow (above).
- Coverage thresholds are ratchets — bump if raised, never lower.

## Phase 2/3 context for future agents

The static registry (`packages/oxagen/src/plugins/registry.ts`) is the integration
point for everything later: Phase 2 reads `tier`/`minPlanTier`/`visibility` for
monetization + preview allowlists; Phase 3 mirrors the manifest schema into a
`plugin.capability_catalog` Postgres table (same zod schema validates both) and adds
an `execution` block to the manifest for out-of-process partner handlers. The kernel
gate and error code need no changes in either phase.

## Implementation notes (Phase 1, this branch)

### Entitlement gate bootstrap call sites

`bootstrapEntitlementRuntime()` is called at the three app entry points, symmetrically with
`bootstrapBillingRuntime()`:

- `apps/api/src/bootstrap.ts` — called in the Hono startup sequence.
- `apps/mcp/src/middleware.ts` — called at module load (before any request handling).
- `apps/app/instrumentation.ts` — called inside the Next.js `register()` hook (dynamic import to
  avoid an edge-incompatible side-effect in the RSC bundle).

If `bootstrapEntitlementRuntime()` is not called, the kernel gate is left in its default
allow-all state (matches the IAM/billing default for backward-compatibility), but an `info`
log is emitted on the first plugin-claimed invocation.

### agent.tool.list filter parity fix

`agent.tool.list` (`packages/agent/src/handlers/agent.tool.list.ts`) was updated to apply the same
entitlement filter as `materializeTools` in `packages/agent/src/runtime/materialize-tools.ts`. The
handler imports `listEntitledCapabilityPluginIds` and `pluginForContract` and skips any builtin
capability whose plugin is not in the org's entitled set. Both surfaces now use the same
`listEntitledCapabilityPluginIds(ctx.orgId)` call so tool visibility is consistent whether the
agent queries its tool list or attempts to invoke a tool.

### apps/api dead-import fix

Commit `78948ff6` removed dead `automation.enable` / `automation.disable` route imports from
`apps/api/src/app.ts`. These imports were introduced in the branch that preceded this one and
referenced route files that were never committed, causing typecheck and lint failures on main.
The fix rode along before the plugin work landed to keep the branch green.

### Migration filename

`packages/database/atlas/migrations/20260612150000_add_capability_plugin_type.sql`

Broadens two CHECK constraints on `plugin.org_listings` (adds `'capability'` to `plugin_type`
and `'oxagen'` to `source`). No new tables, no RLS changes.
