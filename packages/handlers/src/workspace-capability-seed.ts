/**
 * workspace-capability-seed — idempotent default agent_capability plugin seeder.
 *
 * Every new workspace gets the four default first-party capability packs installed
 * so that documents.generate / documents.pdf.create / svg.generate / image.generate /
 * video.generate are immediately available without a capability_not_installed error.
 *
 * Called inside (or immediately after) the workspace-creation transaction — mirrors
 * the pattern used by workspace-registry-seed.
 *
 * All four packs are seeded via the shared upsertCapabilityInstall helper which
 * uses ON CONFLICT DO UPDATE, making repeated calls fully idempotent.
 */

import { withTenantDb } from "@oxagen/database";
import type { Tx } from "@oxagen/database";
import { getOxagenPlugin } from "@oxagen/oxagen/plugins";
import { upsertCapabilityInstall } from "./capability-install";
import { logger } from "./logger";

/**
 * The four first-party capability packs seeded into every new workspace.
 * These ids must exist in the Oxagen plugin registry (packages/oxagen/src/plugins/registry.ts).
 */
export const DEFAULT_SEEDED_CAPABILITY_PLUGIN_IDS = [
  "oxagen/media-video",
  "oxagen/media-image",
  "oxagen/media-svg",
  "oxagen/documents",
] as const;

interface SeedArgs {
  orgId: string;
  workspaceId: string;
  /** Pass an in-flight transaction to participate in the caller's transaction. */
  tx?: Tx;
}

async function runSeed(
  tx: Tx,
  orgId: string,
  workspaceId: string,
): Promise<void> {
  for (const pluginId of DEFAULT_SEEDED_CAPABILITY_PLUGIN_IDS) {
    const manifest = getOxagenPlugin(pluginId);
    if (!manifest) {
      // Guard: should never happen if the catalog is correct. Throw so the
      // workspace-creation transaction rolls back rather than silently skipping.
      throw new Error(
        `[workspace-capability-seed] Unknown plugin id "${pluginId}". ` +
          "Ensure the plugin is registered in the Oxagen plugin registry.",
      );
    }

    const id = await upsertCapabilityInstall(tx, {
      orgId,
      workspaceId,
      pluginId,
      manifest,
    });

    logger.info(
      { installedPluginId: id, pluginId, orgId, workspaceId },
      "workspace-capability-seed: capability pack seeded",
    );
  }
}

/**
 * Idempotently seeds the four default agent_capability packs for a workspace.
 *
 * - Validates each plugin id against the Oxagen plugin registry before inserting.
 * - Each upsert uses ON CONFLICT DO UPDATE — safe to call multiple times.
 * - Pass `tx` to run inside a caller-owned transaction (e.g. workspace creation),
 *   or omit to open a fresh `withTenantDb` session.
 */
export async function seedWorkspaceDefaultCapabilities({
  orgId,
  workspaceId,
  tx: callerTx,
}: SeedArgs): Promise<void> {
  if (callerTx) {
    return runSeed(callerTx, orgId, workspaceId);
  }
  return withTenantDb((tx) => runSeed(tx, orgId, workspaceId));
}
