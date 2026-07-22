---
# MCP Servers

- **Route:** `/{orgSlug}/{workspaceSlug}/workbench/tools/mcp`
- **Nav location:** workspace → Workbench → tab "Tools" → sub-tab "MCP Servers"
- **Priority:** P2
- **Disposition vs today:** Keep

## Purpose
Discover, install, and manage external MCP servers as equipable tool sources — the surface where external tools are brought under Oxagen's typed governance and consent model rather than connected ad hoc. Includes copy-paste install snippets for agents/clients that connect directly.

## Primary user & jobs-to-be-done
- **Primary user:** agent builder / workspace admin
- **JTBD:**
  - Search a catalog of available MCP servers and install one into the workspace
  - See installed servers with live credential status (connected / needs auth / expired)
  - Toggle a server enabled/disabled or uninstall it
  - Copy a ready-to-paste install snippet with a live API key for external clients
  - Re-authenticate a server whose credential has expired

## Functionality
- Catalog search panel: browse/search `browse_plugin_catalog`, install button per result.
- Installed list: table Name · Status (enabled/disabled) · Credential status · Last used; row actions Toggle enabled, Uninstall, Reauth (new).
- Install snippet panel: syntax-highlighted (Shiki) copy-paste block with a live, scoped API key embedded.
- Credential re-auth flow (new UI): triggered from a "needs auth"/"expired" badge, calls reauth contract and updates status inline.

## Capabilities invoked
- `agent.mcp.list` (`list_mcp_servers`) — installed list.
- `agent.mcp.register` (`register_mcp_server`) — manual registration.
- `agent.mcp.delete` (`delete_mcp_server`) — uninstall.
- `agent.mcp.set_enabled` (`set_mcp_enabled`) — toggle.
- `plugin.org.install` (`install_plugin`) / `plugin.org.uninstall` (`uninstall_plugin`) — catalog-driven install/uninstall.
- `plugin.catalog.browse` (`browse_plugin_catalog`) / `plugin.catalog.get` (`get_catalog_plugin`) — catalog search/detail.
- `plugin.credential.set_secret` (`set_plugin_secret`) — credential entry.
- `plugin.credential.reauth` (`reauth_plugin_credential`) — re-auth action (contract exists, no UI today — add here).
- `system.install.instructions` (`get_install_instructions`) — snippet content.

## Data sources
Postgres (mcp_servers, plugin installs, credentials metadata).

## States
- **Empty:** no MCP servers installed — catalog panel front and center.
- **Loading:** skeleton rows for both catalog and installed list, independently.
- **Error:** install/uninstall/toggle failures show inline row-level error, not full-page; catalog fetch failure keeps installed list interactive.

## Existing implementation
- **Today:** COMPLETE for catalog search, installed list with credential status, toggle/uninstall, and copy-paste snippets. Missing: credential re-auth UI — the contract (`reauth_plugin_credential`) exists but nothing invokes it yet; add a Reauth action here.

## Vision alignment
External MCP tools becoming governed via consent + typed registration is the anti-poisoning trust posture at the heart of the wedge — every third-party tool passes through the same accountability chain as first-party ones.
