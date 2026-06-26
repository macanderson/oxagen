/**
 * capability-install — shared helper for idempotent agent_capability plugin upsert.
 *
 * Extracted from the agent_capability branch of plugin.org.install so that
 * workspace-capability-seed (and future callers) can reuse the same DB write
 * without going through the full install handler (which validates visibility and
 * fires audit events — appropriate for user-initiated installs, not for seeding).
 *
 * The upsert is ON CONFLICT DO UPDATE on the (org_id, workspace_id, plugin_type, name)
 * unique index — idempotent by design.
 */

import { sql } from "drizzle-orm";
import { schema } from "@oxagen/database";
import type { Tx } from "@oxagen/database";
import type { OxagenPluginManifest } from "@oxagen/oxagen/plugins";

export interface UpsertCapabilityInstallInput {
  orgId: string;
  workspaceId: string;
  pluginId: string;
  manifest: OxagenPluginManifest;
}

/**
 * Idempotent upsert of a single agent_capability plugin listing.
 *
 * - Runs inside the provided `tx` (caller-owned transaction).
 * - Returns the installed plugin row id (new or existing).
 * - iconUrl stores a structured Lucide reference ("lucide:<name>:<color>") so
 *   the installed-plugins panel can render the correct icon without a manifest
 *   lookup at render time.
 */
export async function upsertCapabilityInstall(
  tx: Tx,
  { orgId, workspaceId, pluginId, manifest }: UpsertCapabilityInstallInput,
): Promise<string> {
  // Build icon reference: "lucide:<iconName>:<color>" or null.
  const iconUrl = manifest.icon
    ? `lucide:${manifest.icon}:${manifest.color ?? ""}`
    : null;

  const [row] = await tx
    .insert(schema.pluginInstalledPlugins)
    .values({
      orgId,
      workspaceId,
      pluginType: "agent_capability",
      source: "oxagen",
      name: pluginId,
      title: manifest.name,
      description: manifest.description,
      iconUrl,
      endpointUrl: null,
      transport: null,
      authKind: "none",
      enabled: true,
    })
    .onConflictDoUpdate({
      target: [
        schema.pluginInstalledPlugins.orgId,
        schema.pluginInstalledPlugins.workspaceId,
        schema.pluginInstalledPlugins.pluginType,
        schema.pluginInstalledPlugins.name,
      ],
      set: {
        // Update icon on re-install in case the manifest changed.
        iconUrl: sql`EXCLUDED.icon_url`,
        title: sql`EXCLUDED.title`,
        description: sql`EXCLUDED.description`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: schema.pluginInstalledPlugins.id });

  if (!row) {
    throw new Error(
      `[upsertCapabilityInstall] Insert returned no row for plugin "${pluginId}".`,
    );
  }

  return row.id;
}
