import type { CapabilityHandler } from "@oxagen/oxagen";
import { integrationInstall } from "@oxagen/oxagen/contracts/integration.install";
import { logger } from "./logger";

export const integrationInstallHandler: CapabilityHandler<typeof integrationInstall> = async (input, ctx) => {
  // TODO: Fetch plugin schema (from catalog or schemaUrl), validate config, persist
  // integration record to Postgres, and dispatch Inngest install job
  const jobId = "job_" + crypto.randomUUID();

  logger.info(
    { jobId, pluginId: input.pluginId, displayName: input.displayName, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    "integration.install: queued (stub)",
  );

  return {
    jobId,
    status: "queued" as const,
    pluginId: input.pluginId,
    displayName: input.displayName,
  };
};
