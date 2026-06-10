import type { CapabilityHandler } from "@oxagen/oxagen";
import { integrationSync } from "@oxagen/oxagen/contracts/integration.sync";
import { logger } from "./logger";

export const integrationSyncHandler: CapabilityHandler<typeof integrationSync> = async (input, ctx) => {
  // TODO: Dispatch Inngest sync job for the integration (incremental or full resync)
  const jobId = "job_" + crypto.randomUUID();

  logger.info(
    { jobId, integrationId: input.integrationId, mode: input.mode, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    "integration.sync: queued (stub)",
  );

  return {
    jobId,
    status: "queued" as const,
    integrationId: input.integrationId,
    mode: input.mode,
  };
};
