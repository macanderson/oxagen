# ADR-013 — Oxagen Plugins: first-party capability packs as a fourth plugin type

**Date:** 2026-06-12
**Status:** Accepted
**Epic:** Installable Plugins Phase 1

## Context

Oxagen ships a large number of capability contracts (image generation, video generation, SVG, document/PDF creation, and more). Today they are all always-on for every organisation — there is no per-org opt-in, no install step, and no way for an admin to review or approve which AI abilities are accessible to their users.

This creates several problems:

1. **Governance gap.** Enterprise customers want explicit control over what generative capabilities exist in their environment before agents can use them.
2. **Monetisation prerequisite.** Premium capabilities (video generation, future agentic add-ons) cannot be plan-gated until there is an install/entitlement model.
3. **Discoverability.** There is no marketplace surface where Oxagen itself can describe and document its own capability packs alongside third-party MCP servers.
4. **Partner path.** Phase 3 will allow third-party partners to publish capability packs that run as separate processes under a scoped protocol. The schema and governance model must be compatible.

Two architectural options were considered:

**Option A — New table + parallel install flow.** Introduce a separate `plugin.capability_catalog` table and a new install endpoint. Clean, but doubles the admin surface, duplicates governance (denylist, set_enabled) logic, and creates a separate code path that must be maintained forever.

**Option B — Fourth plugin type on `plugin.org_listings`.** Add `'capability'` to the `plugin_type` enum and `'oxagen'` to the `source` enum on the existing `plugin.org_listings` table. All existing install/uninstall/denylist/set_enabled contracts operate generically on `org_listings` — they already work with no changes. Manifests live in-repo as pure data. The kernel becomes the single enforcement point.

## Decision

**Adopt Option B.** Introduce Oxagen Plugins as a fourth `plugin_type = 'capability'` that reuses `plugin.org_listings` and the existing contract surface. The kernel entitlement gate is the single enforcement point across all surfaces.

### What an Oxagen Plugin is

An **Oxagen Plugin** is a first-party *capability pack*: a named, versioned bundle of existing capability contracts that an org must install before agents can invoke them. Capabilities not claimed by any plugin remain **builtin** — always available, no install required.

Phase 1 makes four media/document-generation families installable: Video Generation, Image Generation, SVG Generation, and Document Generation. Everything else stays builtin.

### Manifest schema

Manifests are plain TypeScript objects validated by a Zod schema at startup (`packages/oxagen/src/plugins/manifest.ts`). The schema is DB-mirrorable by design: Phase 3 syncs partner manifests into a `plugin.capability_catalog` Postgres table using the same Zod schema as the validation layer. Fields:

```ts
{
  id: "<namespace>/<slug>",           // stable, unique
  name: string,                       // display name
  description: string,
  version: string,                    // semver
  tier: "free" | "premium",
  visibility: "hidden" | "preview" | "beta" | "ga",
  category: string,                   // marketplace grouping
  icon?: string,                      // lucide icon name
  contracts: [string, ...],           // capability names claimed
  minPlanTier?: "free"|"build"|"scale"|"enterprise",  // enforced Phase 2
  scopes: string[],                   // reserved Phase 3
}
```

### Registry invariants

- A contract may be claimed by **at most one plugin**. The registry throws at startup if two manifests claim the same contract name.
- A plugin must claim at least one contract.
- All three apps (api, mcp, app) share the same in-process registry anchored on `globalThis` via `Symbol.for` to survive Turbopack HMR dual-module graphs.

### Kernel as the single enforcement point

The entitlement gate is injected into the kernel via `setCapabilityEntitlementGate`, symmetrically with `setBillingAdmissionGate`. It sits in the hot path of `kernel.invoke()`, after the billing gate, so the API, MCP, and agent surfaces inherit it identically.

Logic:
1. `pluginForContract(capabilityName)` — O(1) in-process lookup; returns `undefined` for builtin contracts.
2. If builtin → allow (no DB call).
3. If plugin-claimed → query `plugin.org_listings` for `plugin_type='capability' AND enabled=true AND deleted_at IS NULL`, minus the org's denylist. TTL-cached at 30 s per orgId.
4. If the plugin id is NOT in the entitled set → throw `capability_not_installed` (new `CapabilityErrorCode`, carries plugin id + install hint).

Tool-list filtering in `materializeTools()` and `agent.tool.list` mirrors the same entitlement check, but this is a UX layer — the kernel gate is the security boundary.

### DB change

One Atlas migration (`20260612150000_add_capability_plugin_type.sql`) broadens two CHECK constraints on `plugin.org_listings`:

```sql
plugin_type IN ('mcp_server', 'integration', 'content_tool', 'capability')
source      IN ('registry', 'custom', 'oxagen')
```

No new tables. No RLS changes (org_listings is already `org_only`).

### Error parity

`capability_not_installed` has the same shape across all surfaces:

```json
{
  "code": "capability_not_installed",
  "message": "The 'video.generate' capability requires the 'oxagen/media-video' plugin (Video Generation) to be installed. Install it from Org settings → Plugins → Oxagen Plugins."
}
```

## Alternatives considered

- **Option A (parallel table).** Rejected: duplicates governance logic and API surface. Every policy change (denylist, set_enabled, workspace-level toggle) would need to be applied twice.
- **Builtin-only forever.** Rejected: unblocks neither governance nor monetisation. Enterprise customers need explicit control.
- **Feature flags per capability.** Rejected: coarser than needed, not customer-visible, no marketplace discoverability.

## Consequences

### Positive

- Zero new tables or RLS policies for Phase 1.
- Existing `plugin.org.install`, `plugin.org.uninstall`, `plugin.org.set_enabled`, `plugin.denylist.*`, and `plugin.org.list` contracts work unchanged with capability listings.
- Schema is forward-compatible with Phase 3 partner plugins (same zod schema validates DB rows).
- Single enforcement point: adding a new surface (a webhook, say) inherits entitlement automatically.

### Constraints and gotchas

- **Uninstall blocks new invocations only.** Running async Inngest jobs that were already dispatched complete normally. Generated assets (images, videos, documents) are customer data — they persist in Vercel Blob + the `content.generated_assets` table and continue to be served via `/api/v1/assets/[id]` after uninstall.
- **Unclaimed contracts are builtin.** A contract that no plugin claims is always available to every org. `plugin.workspace.set_enabled` rejects `capability` listings with a typed error until Phase 2 adds workspace-level granularity.
- **TTL cache means up to 30 s lag** between an admin enabling/disabling a plugin and agents seeing the change. Acceptable for Phase 1; Phase 2 can add a cache-bust on `plugin.org.set_enabled`.
- **`minPlanTier` is recorded but not enforced in Phase 1.** The install endpoint accepts any org regardless of billing plan. Enforcement is Phase 2.
- **Manifest visibility `"hidden"` and `"preview"** are excluded from the browse response. `"beta"` and `"ga"` are shown.

### Phase 2/3 integration points

- Phase 2: enforce `minPlanTier` in the install handler; add `visibility='preview'` allowlist; workspace-level enable/disable.
- Phase 3: `plugin.capability_catalog` Postgres table (same Zod schema); partner manifests ingested via manifest review flow; `execution` block added to manifest for out-of-process handler protocol.

## References

- Spec: `docs/architecture/installable-plugins/specs/2026-06-12-oxagen-plugins-capability-packs.md`
- Prior art: ADR-012 (connector dual-write) for pattern of scoped DB reuse
- Related: `docs/architecture/installable-plugins/specs/2026-06-06-installable-plugins-mcp-design.md`
- Migration: `packages/database/atlas/migrations/20260612150000_add_capability_plugin_type.sql`
- Linear: OXA-1xxx (Oxagen Plugins Phase 1)
