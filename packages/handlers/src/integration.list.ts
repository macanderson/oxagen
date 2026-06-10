import type { CapabilityHandler } from "@oxagen/oxagen";
import { integrationList } from "@oxagen/oxagen/contracts/integration.list";
import { logger } from "./logger";

export const integrationListHandler: CapabilityHandler<typeof integrationList> = async (input, ctx) => {
  // TODO: Query Postgres integrations table with status/pluginId filters, join with sync metrics
  logger.info(
    { status: input.status, pluginId: input.pluginId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    "integration.list: fetched (stub)",
  );

  return {
    integrations: [],
    total: 0,
    hasMore: false,
  };
};
