/**
 * plugin-shape.ts — pure shaping logic for the Workspace → Settings → Plugins tab.
 *
 * Extracted from page.tsx so the install-visibility rules can be unit-tested
 * without rendering a server component or touching the DB.
 *
 * Post-workspace-scoping (2026-06-17): plugins live in `plugin.installed_plugins`
 * with `workspace_id` required. There is no separate org-listings table or
 * per-workspace enable/disable join — the row IS the workspace install. The
 * `enabled` column on the row is the single source of truth for on/off state.
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
export function shapeInstalledPlugins(rows: InstalledPluginRow[]): InstalledPlugin[] {
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
