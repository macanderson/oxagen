---
name: oxagen-plugins
description: Author, modify, or retire an Oxagen Plugin (first-party capability pack) — the manifest schema, static registry, tier/visibility semantics, entitlement gating, marketplace surfacing, and the test/docs checklist. Use whenever a capability should become installable instead of builtin, when adding a new pack, when changing pack assignments or tiers, or when debugging capability_not_installed / missing agent tools. Pairs with oxagen-engineering-policy (law) and oxagen-feature (new contracts).
---

# Oxagen Plugins — authoring capability packs

An **Oxagen Plugin** is a first-party capability pack: a manifest that claims one or
more existing capability contracts and makes them org-installable through the
marketplace instead of always-on. Any contract **not** claimed by a pack is
**builtin** (always available). Architecture: ADR-013 and
`docs/architecture/installable-plugins/specs/2026-06-12-oxagen-plugins-capability-packs.md`.

## How gating works (read before changing anything)

- **Kernel is the enforcement point.** `kernel.invoke()` (packages/oxagen/src/kernel.ts)
  calls the injected entitlement gate for plugin-claimed contracts after the billing
  gate. Refusal = `CapabilityError` code `capability_not_installed` on every surface
  (API, MCP, agent, CLI). Tool-list filtering (`materializeTools`, `agent.tool.list`)
  is UX only.
- **Install state lives in `plugin.org_listings`** (`plugin_type='capability'`,
  `source='oxagen'`, `name=<plugin id>`, disabled by default). Entitled =
  installed + enabled + not soft-deleted + not denylisted. Org-level only (workspace
  enable is Phase 2). 30s TTL cache in
  packages/plugins/src/entitlements/entitlement-service.ts.
- **Bootstrap:** `bootstrapEntitlementRuntime()` must be registered on every runtime —
  already wired in apps/api/src/bootstrap.ts, apps/mcp/src/middleware.ts,
  apps/app/instrumentation.ts. A new app/runtime MUST add it or claimed capabilities
  silently become free (gate default-open when unregistered).

## Adding a new pack

1. **Directory:** `packages/oxagen/src/plugins/catalog/<slug>/manifest.ts` — one dir
   per plugin. Export a manifest satisfying `oxagenPluginManifestSchema`
   (packages/oxagen/src/plugins/manifest.ts):
   - `id`: `oxagen/<slug>` (stable forever — it is the install key in org_listings)
   - `tier`: `free` | `premium` (builtin packs don't exist — builtin = unclaimed)
   - `visibility`: `hidden` (not browsable/installable) → `preview` (Phase 2
     allowlist; currently not browsable) → `beta`/`ga` (browsable)
   - `contracts`: capability names claimed. **A contract may be claimed by at most
     one pack** — the registry throws on duplicates.
   - `minPlanTier`: recorded now, ENFORCED in Phase 2. `scopes`: `[]` (Phase 3).
2. **Register:** add the manifest to the array in
   `packages/oxagen/src/plugins/registry.ts`.
3. **Tests that MUST be updated** (they pin assignments to reality):
   - `packages/oxagen/src/plugins/registry.test.ts` — pack list + contract→plugin
     index cases. `validateOxagenPluginContracts()` will fail if a claimed contract
     name doesn't exist in the contract registry (typo guard).
   - `packages/handlers/src/plugin.catalog.browse.test.ts` — browse count/content
     assertions include your pack (unless hidden/preview).
4. **Nothing else is needed** for gating: kernel gate, browse, install, org settings
   list, enable/disable, denylist, and the agent tool filters all key off the
   registry + org_listings generically.
5. **Docs:** update the launch-pack table in
   `apps/docs/content/docs/plugins/oxagen-plugins.mdx` and the spec's assignment
   table. New user-visible behavior → ADR only if the architecture changed.
6. **E2E:** `apps/app/e2e/oxagen-plugins-marketplace.spec.ts` asserts the visible
   pack set — update its expectations.

## Moving an existing builtin capability into a pack (breaking-ish)

Claiming a contract that orgs already use makes it stop working for them until they
install the pack. Pre-launch this is fine; post-launch it needs a backfill migration
that inserts enabled org_listings rows for orgs with recent usage (ClickHouse
tool-invocation telemetry identifies them). Write that migration BEFORE shipping the
claim, in the same PR.

## Retiring a pack

Set `visibility: "hidden"` first (stops new installs; existing installs keep
working). Removing a manifest entirely makes its contracts builtin again — usually
not what you want; if the contracts are also being removed, follow the contract
deprecation path in oxagen-engineering-policy.

## Gotchas

- `name` in org_listings holds the **plugin id** (`oxagen/media-svg`), while the
  browse output's `title` holds the display name. Don't swap them.
- `installed`/`tier` are optional fields on `plugin.catalog.browse` output — only
  capability entries carry them.
- The entitlement cache is 30s: after install/enable in a test or script, call
  `clearEntitlementCacheForTests()` or wait out the TTL before asserting.
- Coverage thresholds are ratchets in every touched package — bump, never lower.
- `plugin.workspace.set_enabled` rejects capability listings until Phase 2 — don't
  "fix" that error away.
- Premium enforcement (plan tiers, meter rates) is Phase 2 — `tier: "premium"`
  currently affects only the badge. Do not invent ad-hoc billing checks.

## Phase 2/3 integration points (for future agents)

- Phase 2 (monetization): read `tier`/`minPlanTier` at install time + meter rates in
  packages/billing pricing.ts; `visibility: "preview"` + org allowlist for gradual
  rollout; workspace-level enablement.
- Phase 3 (partners): mirror `oxagenPluginManifestSchema` into a Postgres catalog
  table (same zod validates both); add an `execution` block (out-of-process endpoint,
  context-envelope scopes); the kernel gate and error code need no changes.
