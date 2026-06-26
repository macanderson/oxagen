/**
 * plugin.catalog-sync — periodic registry catalog synchronization cron.
 *
 * Runs every 6 hours. Syncs all enabled MCP registries into the local
 * mcp.catalog_servers table so the marketplace browse page loads instantly
 * without a live fetch to the upstream registry.
 *
 * Uses incremental sync (stored cursor) by default — only fetches new/updated
 * entries since the last sync. A full re-sync happens on the first run for
 * each registry (cursor is null).
 *
 * Each registry is processed in its own step.run() for isolation — a single
 * failing registry doesn't block others.
 */
import { createFunction } from "../create-function";
import {
  syncAllRegistries,
  type SyncAllResult,
  type SyncResult,
} from "@oxagen/plugins/catalog-sync";
import { logger } from "../logger";

export const [pluginCatalogSync] = createFunction(
  { id: "plugin.catalog-sync", retries: 1 },
  { cron: "0 */6 * * *" },
  async ({ step }) => {
    // step.run wraps its return in Inngest's JsonifyObject which erases the
    // concrete type. Re-pin to SyncAllResult via assertion outside the step.
    const result = (await step.run("sync-all-registries", async () => {
      return syncAllRegistries({ fullSync: false });
    })) as unknown as SyncAllResult;

    logger.info(
      {
        total: result.total,
        succeeded: result.succeeded,
        failed: result.failed,
        totalEntries: result.results.reduce(
          (sum: number, r: SyncResult) => sum + r.entriesUpserted,
          0,
        ),
      },
      "plugin.catalog-sync cron complete",
    );

    if (result.failed > 0) {
      logger.warn(
        { errors: result.errors },
        "plugin.catalog-sync: some registries failed to sync",
      );
    }

    return {
      total: result.total,
      succeeded: result.succeeded,
      failed: result.failed,
      totalEntries: result.results.reduce(
        (sum: number, r: SyncResult) => sum + r.entriesUpserted,
        0,
      ),
    };
  },
);
