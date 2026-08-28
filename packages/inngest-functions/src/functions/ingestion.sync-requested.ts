import { createFunction } from "../create-function";
import { inngest } from "../inngest";
import { withSystemDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { logger } from "../logger";

interface SourceConnectionRow {
  id: string;
  connector_id: string;
  delivery_method: string;
  delivery_config: Record<string, unknown> | null;
  status: string;
}

/**
 * Handles `ingestion/sync.requested` events dispatched by the
 * `integration.sync` handler.
 *
 * Responsibilities:
 *   1. Look up the source connection row from Postgres (system scope because
 *      this function runs outside the tenant DB session).
 *   2. Dispatch the connector-appropriate sync event:
 *        - "github"  → `ingestion/github.initial-sync`
 *        - others    → log "unsupported connector for sync" (extend as needed)
 *   3. Update `last_sync_at` on the source connection to stamp the sync time.
 *
 * Concurrency: capped at 4 per org so that bulk "sync all" calls don't fan
 * out uncontrollably.
 *
 * Retries: 3 (Inngest default). Idempotent — re-dispatching an already-running
 * `ingestion/github.initial-sync` for the same connection is safe: the
 * initial-sync function marks the connection `active` at the end, so a
 * duplicate dispatch re-runs the full tree fetch and overwrites.
 */
export const [ingestionSyncRequested] = createFunction(
  {
    id: "ingestion-sync-requested",
    retries: 3,
    concurrency: { limit: 4, key: "event.data.orgId" },
  },
  { event: "ingestion/sync.requested" },
  async ({ event, step }) => {
    const {
      connectionId,
      orgId,
      workspaceId,
      integrationId,
      mode,
      syncMethod,
      jobId,
    } = event.data as {
      connectionId: string;
      orgId: string;
      workspaceId: string;
      integrationId: string;
      mode: string;
      syncMethod: string;
      jobId: string;
    };

    // ── Step 1: Resolve the source connection ────────────────────────────────
    const conn = await step.run(
      "resolve-connection",
      async (): Promise<SourceConnectionRow | null> => {
        const rows = await withSystemDb(async (tx) => {
          const result = await tx.execute(sql`
          SELECT id,
                 connector_id,
                 delivery_method,
                 delivery_config,
                 status
          FROM   ingestion.source_connections
          WHERE  id     = ${connectionId}::uuid
          AND    org_id = ${orgId}::uuid
          AND    deleted_at IS NULL
          LIMIT  1
        `);
          return Array.from(result) as unknown as SourceConnectionRow[];
        });
        return rows[0] ?? null;
      },
    );

    if (!conn) {
      logger.warn(
        { connectionId, orgId, jobId },
        "ingestion-sync-requested: connection not found — skipping",
      );
      return { skipped: true, reason: "connection_not_found" };
    }

    if (conn.status === "deleting" || conn.status === "deleted") {
      logger.warn(
        { connectionId, orgId, jobId, status: conn.status },
        "ingestion-sync-requested: connection is being deleted — skipping",
      );
      return { skipped: true, reason: "connection_deleted" };
    }

    // ── Step 2: Dispatch connector-specific sync event ────────────────────────
    await step.run("dispatch-connector-sync", async () => {
      const dc = conn.delivery_config;

      if (conn.connector_id === "github") {
        // GitHub: re-run the full tree sync. deliveryConfig carries the
        // owner/repo/defaultBranch set during the connection wizard.
        const owner = typeof dc?.["owner"] === "string" ? dc["owner"] : "";
        const repo = typeof dc?.["repo"] === "string" ? dc["repo"] : "";
        const defaultBranch =
          typeof dc?.["defaultBranch"] === "string"
            ? dc["defaultBranch"]
            : "main";

        if (!owner || !repo) {
          logger.warn(
            { connectionId, orgId, jobId, connectorId: conn.connector_id },
            "ingestion-sync-requested: github deliveryConfig missing owner/repo — skipping connector dispatch",
          );
          return;
        }

        await inngest.send({
          name: "ingestion/github.initial-sync" as never,
          data: {
            connectionId,
            orgId,
            workspaceId,
            owner,
            repo,
            defaultBranch,
          },
        });

        logger.info(
          {
            connectionId,
            orgId,
            workspaceId,
            owner,
            repo,
            defaultBranch,
            mode,
            syncMethod,
            jobId,
          },
          "ingestion-sync-requested: dispatched ingestion/github.initial-sync",
        );
      } else {
        // For other connectors, polling sync is not yet implemented. This stub
        // logs the request so it is traceable and the slot can be filled per-connector.
        logger.info(
          {
            connectionId,
            orgId,
            workspaceId,
            connectorId: conn.connector_id,
            mode,
            syncMethod,
            jobId,
          },
          "ingestion-sync-requested: connector does not support sync dispatch yet — integration must implement its own polling handler",
        );
      }
    });

    // ── Step 3: Stamp last_sync_at ────────────────────────────────────────────
    await step.run("update-last-sync-at", () =>
      withSystemDb((tx) =>
        tx.execute(sql`
          UPDATE ingestion.source_connections
          SET    last_sync_at = NOW(),
                 updated_at   = NOW()
          WHERE  id     = ${connectionId}::uuid
          AND    org_id = ${orgId}::uuid
        `),
      ),
    );

    logger.info(
      {
        connectionId,
        orgId,
        workspaceId,
        integrationId,
        mode,
        syncMethod,
        jobId,
      },
      "ingestion-sync-requested: completed",
    );

    return {
      connectionId,
      connectorId: conn.connector_id,
      mode,
      syncMethod,
      jobId,
    };
  },
);
