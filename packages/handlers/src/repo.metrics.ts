import type { CapabilityHandler } from "@oxagen/oxagen";
import { repoMetrics } from "@oxagen/oxagen/contracts/repo.metrics";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DeliveryConfig } from "@oxagen/ingestion/filters";
import {
  sourceConnectionRefCondition,
  toContractStatus,
} from "./lib/connection-status";
import { logger } from "./logger";

/**
 * repo.metrics — sync statistics for a repository connection, read from
 * Postgres (ingestion.source_connections — the operational source of truth for
 * connector health). Mirrors integration.metrics and adds the repo-contract
 * fields syncIntervalSeconds + estimatedNextSyncAt.
 *
 * No ClickHouse query: source_connections already carries the scalar entity
 * count, last-sync timestamp, status, and last error. Fields with no backing
 * column (per-type entity breakdown, sync duration) are returned empty or
 * null instead of being fabricated.
 */
export const repoMetricsHandler: CapabilityHandler<typeof repoMetrics> = async (
  input,
  ctx,
) => {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.sourceConnections.publicId,
        displayName: schema.sourceConnections.displayName,
        deliveryMethod: schema.sourceConnections.deliveryMethod,
        deliveryConfig: schema.sourceConnections.deliveryConfig,
        status: schema.sourceConnections.status,
        entityCount: schema.sourceConnections.entityCount,
        lastSyncAt: schema.sourceConnections.lastSyncAt,
        errorMessage: schema.sourceConnections.errorMessage,
        updatedAt: schema.sourceConnections.updatedAt,
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
      "repo.metrics: not found",
    );
    throw new HTTPException(404, {
      message: "Repository connection not found",
    });
  }

  const status = toContractStatus(row.status);
  const deliveryConfig = (row.deliveryConfig ?? {}) as DeliveryConfig;
  const syncMethod =
    deliveryConfig.syncMethod ?? row.deliveryMethod ?? "manual";

  // syncIntervalSeconds is only meaningful for polling connections.
  const syncIntervalSeconds =
    syncMethod === "polling"
      ? (deliveryConfig.syncIntervalSeconds ?? null)
      : null;

  // The next scheduled sync only exists for an actively-polling connection that
  // has already synced once; otherwise there's nothing to estimate from.
  const estimatedNextSyncAt =
    syncMethod === "polling" &&
    status === "active" &&
    row.lastSyncAt &&
    syncIntervalSeconds
      ? new Date(
          row.lastSyncAt.getTime() + syncIntervalSeconds * 1000,
        ).toISOString()
      : null;

  // The row records an error message but no dedicated last_error_at column; when
  // in the error state use updatedAt as a best-effort proxy (same as metrics).
  const hasError = row.status === "error" && row.errorMessage != null;

  logger.info(
    {
      repoId: input.repoId,
      status,
      entityCount: row.entityCount,
      orgId: ctx.orgId,
    },
    "repo.metrics: fetched",
  );

  return {
    repoId: row.publicId,
    displayName: row.displayName,
    status,
    entityCount: row.entityCount,
    // source_connections stores a scalar count, not a per-type breakdown.
    entityCountByType: {},
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    // No source column for sync duration.
    lastSyncDurationMs: null,
    lastErrorAt: hasError ? row.updatedAt.toISOString() : null,
    errorMessage: row.errorMessage ?? null,
    syncIntervalSeconds,
    estimatedNextSyncAt,
  };
};
