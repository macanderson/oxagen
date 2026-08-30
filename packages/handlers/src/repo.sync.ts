import type { CapabilityHandler } from "@oxagen/oxagen";
import { repoSync } from "@oxagen/oxagen/contracts/repo.sync";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DeliveryConfig } from "@oxagen/ingestion/filters";
import { eventClient } from "./event-client";
import { sourceConnectionRefCondition } from "./lib/connection-status";
import { logger } from "./logger";

/**
 * repo.sync — trigger an incremental or full re-index of a repository
 * connection. A repository connection is an `ingestion.source_connections` row
 * (typically connectorId="github"); repo.* is the code-repo specialization of
 * the generic connection.* / integration.* surface and shares the same backing
 * table and Inngest sync pipeline.
 *
 * Mirrors integration.sync: resolves the connection (by public ID or UUID),
 * then emits `ingestion/sync.requested` for the Inngest sync function to pick
 * up. The cron cadence for polling connections is owned by a separate Inngest
 * scheduled function; this handler enqueues a one-off job.
 *
 * estimatedRecords: a true pre-sync estimate would require querying the source
 * API, which this synchronous enqueue path deliberately avoids. For a `full`
 * re-index every already-ingested entity is reprocessed, so the connection's
 * current entityCount is a safe lower bound; for `incremental` the delta is
 * unknown until the job diffs the cursor, so we report 0 rather than fabricate.
 */
export const repoSyncHandler: CapabilityHandler<typeof repoSync> = async (
  input,
  ctx,
) => {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.sourceConnections.id,
        deliveryMethod: schema.sourceConnections.deliveryMethod,
        deliveryConfig: schema.sourceConnections.deliveryConfig,
        status: schema.sourceConnections.status,
        entityCount: schema.sourceConnections.entityCount,
      })
      .from(schema.sourceConnections)
      .where(
        and(
          eq(schema.sourceConnections.orgId, ctx.orgId),
          eq(schema.sourceConnections.workspaceId, ctx.workspaceId),
          sourceConnectionRefCondition(input.repoId),
          isNull(schema.sourceConnections.deletedAt),
        ),
      )
      .limit(1),
  );

  if (!row) {
    logger.warn(
      { repoId: input.repoId, orgId: ctx.orgId },
      "repo.sync: not found",
    );
    throw new HTTPException(404, {
      message: "Repository connection not found",
    });
  }

  if (row.status === "deleting" || row.status === "deleted") {
    throw new HTTPException(409, {
      message: `Repository connection is '${row.status}' — cannot sync a connection being deleted`,
    });
  }

  const deliveryConfig = (row.deliveryConfig ?? {}) as DeliveryConfig;
  const syncMethod =
    deliveryConfig.syncMethod ?? row.deliveryMethod ?? "manual";
  const syncIntervalSeconds = deliveryConfig.syncIntervalSeconds ?? 300;
  const jobId = "job_" + crypto.randomUUID();

  await eventClient.send({
    name: "ingestion/sync.requested",
    data: {
      jobId,
      connectionId: row.id,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      integrationId: input.repoId,
      mode: input.mode,
      syncMethod,
      syncIntervalSeconds,
      requestedAt: new Date().toISOString(),
    },
  });

  logger.info(
    {
      jobId,
      repoId: input.repoId,
      connectionId: row.id,
      mode: input.mode,
      recordTypes: input.recordTypes,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
    "repo.sync: queued",
  );

  return {
    jobId,
    status: "queued" as const,
    mode: input.mode,
    estimatedRecords: input.mode === "full" ? row.entityCount : 0,
  };
};
