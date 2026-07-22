---
# Marketplace — Agent Tools

- **Route:** `/{orgSlug}/{workspaceSlug}/marketplace/agent-tools`
- **Nav location:** workspace → footer → Marketplace → tab "Agent Tools"
- **Priority:** P2
- **Disposition vs today:** Keep + fix bulk-install

## Purpose
The install catalog for everything an agent can be equipped with — skills, MCP servers, and capabilities. A workspace member browses and installs from here; installs land as entitlement-gated capabilities managed under Workbench → Agent Tools. The catalog itself is complete and functional; the defect is a broken bulk-install path that silently discards the multi-select action it was built to support.

## Primary user & jobs-to-be-done
- **Primary user:** workspace admin equipping agents with new tools
- **JTBD:**
  - Search/filter the catalog by type (MCP server, skill, capability, knowledge source) and plan tier
  - Install one tool with a single click
  - Select several tools at once and install them together, auditable as one action

## Functionality
- **Card grid** (existing): search input, type badge, tier badge (`free`/`premium`), per-card Install button, "Installed" state.
- **Fix — bulk install:** add checkbox multi-select to each card, a selection toolbar ("N selected · Install selected"), and wire it to the `installBulkAction` prop the page already passes in but the panel currently discards (`void installBulkAction;` in `browse-panel.tsx`). `plugin.org.install_bulk` declares `"app"` in its `layers[]` — this is a real UI Capability Parity gap (capability promised on `app`, no working surface), not cosmetic.
- **Consolidation note:** a working checkbox-multi-select → "Install selected" flow already exists on `workbench/tools/capabilities` via `MarketplaceModal` (statically traced to `invoke("install_plugins_bulk")`, not yet screenshot-proven). Port that interaction pattern into this page rather than re-inventing it, and consider whether the two catalog UIs should consolidate into one.
- Per-item install failures must show inline per row (bulk install is not all-or-nothing).

## Capabilities invoked
- `plugin.catalog.browse` (`browse_plugin_catalog`, via `GET /api/v1/plugin/catalog/browse`) — catalog data.
- `plugin.org.install` (`install_plugin`) — single-card install.
- `plugin.org.install_bulk` (`install_plugins_bulk`) — bulk install; currently unwired here, see fix above.
- `plugin.registry.list` (`list_plugin_registries`) — registry source filter, if surfaced.

## Data sources
Postgres: org plugin listings / installs, workspace registries.

## States
- **Empty:** "No results" for a search/filter with no matches.
- **Loading:** skeleton cards.
- **Error:** catalog fetch failure shows a retry banner; install failure toasts per item, bulk failures list per-item errors in the selection toolbar.

## Existing implementation
- **Today:** COMPLETE catalog browse + single-card install, reusing the same server actions (`installPlugin`/`installBulkPlugin` in `@/lib/agent-tools/install-actions`) as the legacy `MarketplaceModal`. **Known defect:** `installBulkAction` is received as a prop and voided — no multi-select UI exists on this page. Fix in place; do not rebuild the catalog.

## Vision alignment
Install-time governance — every install lands as a typed, entitlement-gated capability, not a loose script — is the accountability chain applied to tool acquisition (wedge 2). P2: high-value fix on an otherwise-complete surface, not new capability work.
