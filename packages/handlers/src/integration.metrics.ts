import type { CapabilityHandler } from "@oxagen/oxagen";
import { integrationMetrics } from "@oxagen/oxagen/contracts/integration.metrics";
import { logger } from "./logger";

export const integrationMetricsHandler: CapabilityHandler<typeof integrationMetrics> = async (input, ctx) => {
  // TODO: Query Postgres for integration metadata and ClickHouse for sync execution metrics
  logger.info(
    { integrationId: input.integrationId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    "integration.metrics: fetched (stub)",
  );

  return {
    integrationId: input.integrationId,
    pluginId: "unknown",
    displayName: input.integrationId,
    status: "pending_setup" as const,
    entityCount: 0,
    entityCountByType: {},
    lastSyncAt: null,
    lastSyncDurationMs: null,
    lastErrorAt: null,
    errorMessage: null,
  };
};
