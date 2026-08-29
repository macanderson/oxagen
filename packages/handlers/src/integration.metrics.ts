import type { CapabilityHandler } from "@oxagen/oxagen";
import { integrationMetrics } from "@oxagen/oxagen/contracts/integration.metrics";
import type { IntegrationMetricsOutput } from "@oxagen/oxagen/contracts/integration.metrics";
import { schema, withTenantDb } from "@oxagen/database";
import { eq, and, isNull } from "drizzle-orm";
import { logger } from "./logger";

/**
 * integration.metrics handler.
 *
 * Reads sync statistics for a single source connection from Postgres
 * (ingestion.source_connections — the operational source of truth for
 * connector health and ingestion progress). The `integrationId` input
 * resolves to source_connections.publicId (prefix `con_`), tenant-scoped
 * by org + workspace, exactly like integration.configure.
 *
 * There is no ClickHouse query here: source_connections already carries the
 * scalar entity count, last-sync timestamp, status, and last error message.
 * Fields with no backing column (per-type entity breakdown, sync duration)
 * are returned empty or null instead of being fabricated.
 */

// Source DB status enum → contract status enum. The DB CHECK constraint allows
// 'pending_setup' | 'connected' | 'paused' | 'error' | 'deleting' | 'deleted';
// the contract exposes 'active' | 'paused' | 'failed' | 'pending_setup'. Deleting
// and deleted connections collapse to 'pending_setup' (no live data to report).
const DB_STATUS_TO_CONTRACT_STATUS: Record<
  string,
  IntegrationMetricsOutput["status"]
> = {
  pending_setup: "pending_setup",
  connected: "active",
  paused: "paused",
  error: "failed",
  deleting: "pending_setup",
  deleted: "pending_setup",
};

export const integrationMetricsHandler: CapabilityHandler<
  typeof integrationMetrics
> = async (input, ctx) => {
  // Resolve source connection by public ID — same tenant-scoped WHERE clause as
  // integration.configure (publicId + orgId + workspaceId + not soft-deleted).
  const [row] = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.sourceConnections.publicId,
        connectorId: schema.sourceConnections.connectorId,
        displayName: schema.sourceConnections.displayName,
        status: schema.sourceConnections.status,
        entityCount: schema.sourceConnections.entityCount,
        lastSyncAt: schema.sourceConnections.lastSyncAt,
        errorMessage: schema.sourceConnections.errorMessage,
        updatedAt: schema.sourceConnections.updatedAt,
      })
      .from(schema.sourceConnections)
      .where(
        and(
          eq(schema.sourceConnections.publicId, input.integrationId),
          eq(schema.sourceConnections.orgId, ctx.orgId),
          eq(schema.sourceConnections.workspaceId, ctx.workspaceId),
          isNull(schema.sourceConnections.deletedAt),
        ),
      )
      .limit(1),
  );

  if (!row) {
    throw new Error(
      `integration.metrics: integration not found: ${input.integrationId}`,
    );
  }

  const status = DB_STATUS_TO_CONTRACT_STATUS[row.status] ?? "pending_setup";

  // The connection only records an error message and timestamp via updatedAt;
  // there is no dedicated last_error_at column. When the connection is in the
  // error state with a message, use the connection's updatedAt as a best-effort
  // proxy for when the error was last observed; otherwise report no error time.
  const hasError = row.status === "error" && row.errorMessage != null;
  const lastErrorAt = hasError ? row.updatedAt.toISOString() : null;

  logger.info(
    {
      integrationId: input.integrationId,
      connectorId: row.connectorId,
      status,
      entityCount: row.entityCount,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
    "integration.metrics: fetched",
  );

  return {
    integrationId: row.publicId,
    pluginId: row.connectorId,
    displayName: row.displayName,
    status,
    entityCount: row.entityCount,
    // source_connections stores only a scalar entity count, not a per-type
    // breakdown.
    entityCountByType: {},
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    // No source column for sync duration.
    lastSyncDurationMs: null,
    lastErrorAt,
    errorMessage: row.errorMessage ?? null,
  };
};
