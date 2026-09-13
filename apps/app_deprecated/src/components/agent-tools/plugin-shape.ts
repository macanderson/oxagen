/**
 * plugin-shape.ts — pure shaping logic for Workbench → Tools → Capabilities.
 *
 * Extracted from page.tsx so the install-visibility rules can be unit-tested
 * without rendering a server component or touching the DB.
 *
 * A plugin row in `plugin.installed_plugins` always carries a `workspace_id`,
 * so the row itself IS the workspace install — there is no separate listing
 * table and no per-workspace enable/disable join. The row's `enabled` column is
 * the single source of truth for on/off state.
 */
import type { InstalledPlugin } from "./workspace-plugins-panel";

/** Minimal structural shape of a `plugin.installed_plugins` row this module needs. */
export interface InstalledPluginRow {
  id: string;
  name: string;
  title: string | null;
  description: string | null;
  iconUrl: string | null;
  pluginType: string;
  authKind: string;
  enabled: boolean;
}

/**
 * Shapes workspace-scoped installed plugin rows into the InstalledPlugin[] the
 * panel renders. Pure: no DB, no React — safe to unit test.
 *
 * @param rows - Non-deleted `plugin.installed_plugins` rows for the workspace.
 */
export function shapeInstalledPlugins(
  rows: InstalledPluginRow[],
): InstalledPlugin[] {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    title: row.title,
    description: row.description,
    iconUrl: row.iconUrl,
    pluginType: row.pluginType,
    authKind: row.authKind,
    enabled: row.enabled,
    wsEnabled: row.enabled,
  }));
}
