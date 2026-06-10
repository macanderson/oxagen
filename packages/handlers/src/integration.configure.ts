import type { CapabilityHandler } from "@oxagen/oxagen";
import { integrationConfigure } from "@oxagen/oxagen/contracts/integration.configure";
import { logger } from "./logger";

export const integrationConfigureHandler: CapabilityHandler<typeof integrationConfigure> = async (input, ctx) => {
  // TODO: Load existing integration record from Postgres, apply config patches, persist
  const now = new Date().toISOString();

  logger.info(
    { integrationId: input.integrationId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    "integration.configure: updated (stub)",
  );

  return {
    integrationId: input.integrationId,
    displayName: input.displayName ?? input.integrationId,
    syncCadence: input.syncCadence ?? "manual",
    inferenceEnabled: input.inferenceEnabled ?? false,
    updatedAt: now,
  };
};
