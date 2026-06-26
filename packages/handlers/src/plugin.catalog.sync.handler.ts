/**
 * plugin.catalog.sync handler — triggers an immediate registry catalog sync
 * for the workspace. Exposed as a capability so the UI can offer a "Refresh"
 * button in the marketplace.
 */
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { syncAllRegistries } from "@oxagen/plugins/catalog-sync";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { fullSync } = input as { fullSync: boolean };

  const startedAt = Date.now();
  const result = await syncAllRegistries({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    fullSync,
  });

  return {
    total: result.total,
    succeeded: result.succeeded,
    failed: result.failed,
    totalEntries: result.results.reduce((sum, r) => sum + r.entriesUpserted, 0),
    durationMs: Date.now() - startedAt,
  };
};
