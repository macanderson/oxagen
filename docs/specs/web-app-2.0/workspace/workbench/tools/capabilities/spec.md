---
# Capabilities

- **Route:** `/{orgSlug}/{workspaceSlug}/workbench/tools/capabilities`
- **Nav location:** workspace → Workbench → tab "Tools" → sub-tab "Capabilities"
- **Priority:** P2
- **Disposition vs today:** Keep (consolidation target of 3 legacy redirects)

## Purpose
Manage the capability packs (plugins) installed into this workspace and the plugin registries they're sourced from — enable/disable, uninstall, and configure which registries the workspace pulls from. This is workspace-scoped installed-pack management, distinct from the org-wide typed-contract catalog.

## Primary user & jobs-to-be-done
- **Primary user:** workspace admin
- **JTBD:**
  - See every capability pack installed in this workspace and its enabled state
  - Enable/disable a pack without uninstalling it
  - Uninstall a pack no longer needed
  - Add or remove a plugin registry source and browse its versions

## Functionality
- Installed packs table: Name · Version · Enabled toggle · Source registry · Uninstall action.
- Registry manager panel: list of registries (Add / Remove), each with a "browse versions" link.
- Version list per pack (from registry): pick/pin a version before install where applicable.
- Cross-link banner: "Looking for the org-wide typed-contract catalog? See Governance → Capabilities" pointing to `/{orgSlug}/governance/capabilities`.

## Capabilities invoked
- `plugin.org.list` (`list_plugins`) — installed packs table.
- `plugin.org.install` (`install_plugin`) / `plugin.org.uninstall` (`uninstall_plugin`) — install/uninstall.
- `plugin.set_enabled` (`set_plugin_enabled`) — enable/disable toggle.
- `plugin.registry.list` (`list_plugin_registries`) / `.add` (`add_plugin_registry`) / `.remove` (`remove_plugin_registry`) — registry manager.
- `plugin.version.list` (`list_plugin_versions`) — version picker.

## Data sources
Postgres (installed plugins, registries, versions).

## States
- **Empty:** no capability packs installed — CTA to add a registry or browse the default one.
- **Loading:** table skeleton for installed packs; registry panel loads independently.
- **Error:** enable/disable/uninstall failures show inline row error; registry add/remove failures surface in the registry panel only.

## Existing implementation
- **Today:** COMPLETE — enable/disable toggle, uninstall, and registry add/remove manager all wired. Three legacy routes redirect here; this page is the consolidation target — collapse the shims once callers are updated.

## Vision alignment
Workspace-installed capability packs are the operational surface of the contract-governed toolset; keeping this distinct from (but cross-linked to) the org-wide contract catalog under Governance preserves the org-vs-workspace scoping the accountability chain depends on.
