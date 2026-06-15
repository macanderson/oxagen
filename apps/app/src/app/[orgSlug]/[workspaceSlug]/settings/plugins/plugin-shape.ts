/**
 * plugin-shape.ts — pure shaping logic for the Workspace → Settings → Plugins tab.
 *
 * Extracted from page.tsx so the install-visibility rules can be unit-tested
 * without rendering a server component or touching the DB.
 *
 * Two plugin scoping models coexist:
 *
 *   • Capability packs (`pluginType === "capability"`) are ORG-LEVEL (Phase 1).
 *     They live only in `plugin.org_listings` and NEVER create a per-workspace
 *     `mcp.mcp_servers` install row. Their effective on/off state IS the org
 *     listing's `enabled` flag. They must be shown on the workspace tab based on
 *     the org listing alone — otherwise installed capabilities (Image/Video/SVG/
 *     Document Generation) appear in the marketplace modal as "Installed" but are
 *     invisible here (the reported bug).
 *
 *   • MCP servers / integrations / content tools are WORKSPACE-LEVEL: enabling
 *     one writes an `mcp.mcp_servers` row scoped to the workspace. They appear
 *     only when the org still allows them (`enabled`) AND a workspace install row
 *     exists; their on/off state comes from that row.
 */
import type { InstalledPlugin } from "./workspace-plugins-panel";

/** Minimal structural shape of a `plugin.org_listings` row this module needs. */
export interface OrgListingRow {
  id: string;
  name: string;
  title: string | null;
  description: string | null;
  iconUrl: string | null;
  pluginType: string;
  authKind: string;
  enabled: boolean;
}

/** Minimal structural shape of an `mcp.mcp_servers` workspace-install row. */
export interface WsInstallRow {
  orgListingId: string | null;
  enabled: boolean;
}

/** True when the listing is an org-level capability pack (no workspace row). */
export function isCapabilityListing(pluginType: string): boolean {
  return pluginType === "capability";
}

/**
 * Shapes org listings + workspace install rows into the InstalledPlugin[] the
 * panel renders. Pure: no DB, no React — safe to unit test.
 *
 * @param listings - Non-deleted org listings for the org.
 * @param wsInstalls - mcp.mcp_servers rows for the current workspace.
 */
export function shapeInstalledPlugins(
  listings: OrgListingRow[],
  wsInstalls: WsInstallRow[],
): InstalledPlugin[] {
  const wsInstallMap: Record<string, WsInstallRow> = {};
  for (const row of wsInstalls) {
    if (row.orgListingId) wsInstallMap[row.orgListingId] = row;
  }

  return listings
    .filter((listing) => {
      if (isCapabilityListing(listing.pluginType)) {
        // Org-level capability pack — installed means the listing exists.
        return true;
      }
      // Workspace-level plugin — only show org-allowed ones with a ws install.
      return listing.enabled && wsInstallMap[listing.id] !== undefined;
    })
    .map((listing) => {
      const wsRow = wsInstallMap[listing.id];
      return {
        id: listing.id,
        name: listing.name,
        title: listing.title,
        description: listing.description,
        iconUrl: listing.iconUrl,
        pluginType: listing.pluginType,
        authKind: listing.authKind,
        enabled: listing.enabled,
        // Capability packs have no per-workspace row; their effective on/off
        // state is the org-level enabled flag. Other types use the ws row.
        wsEnabled: isCapabilityListing(listing.pluginType)
          ? listing.enabled
          : (wsRow?.enabled ?? false),
      };
    });
}
