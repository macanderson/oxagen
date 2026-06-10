import type { CapabilityHandler } from "@oxagen/oxagen";
import { integrationGet } from "@oxagen/oxagen/contracts/integration.get";
import { logger } from "./logger";

export const integrationGetHandler: CapabilityHandler<typeof integrationGet> = async (input, ctx) => {
  // TODO: Query Postgres integrations table by ID, join with plugin schema from catalog
  const now = new Date().toISOString();

  logger.info(
    { integrationId: input.integrationId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    "integration.get: fetched (stub)",
  );

  return {
    id: input.integrationId,
    pluginId: "unknown",
    displayName: input.integrationId,
    version: "1.0.0",
    status: "pending_setup" as const,
    config: {},
    schema: null,
    entityCount: 0,
    lastSyncAt: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
  };
};
