import type { CapabilityHandler } from "@oxagen/oxagen";
import { repoMetrics } from "@oxagen/oxagen/contracts/repo.metrics";
import { logger } from "./logger";

export const repoMetricsHandler: CapabilityHandler<typeof repoMetrics> = async (input, ctx) => {
  // TODO: Query Postgres for connection metadata and ClickHouse for sync metrics
  logger.info(
    { repoId: input.repoId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    "repo.metrics: fetched (stub)",
  );

  return {
    repoId: input.repoId,
    displayName: input.repoId,
    status: "active" as const,
    entityCount: 0,
    entityCountByType: {},
    lastSyncAt: null,
    lastSyncDurationMs: null,
    lastErrorAt: null,
    errorMessage: null,
    syncIntervalSeconds: null,
    estimatedNextSyncAt: null,
  };
};
