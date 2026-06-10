import type { CapabilityHandler } from "@oxagen/oxagen";
import { integrationDelete } from "@oxagen/oxagen/contracts/integration.delete";
import { logger } from "./logger";

export const integrationDeleteHandler: CapabilityHandler<typeof integrationDelete> = async (input, ctx) => {
  // TODO: Soft-delete integration in Postgres, dispatch Inngest deletion job to
  // optionally purge entity nodes and edges from Neo4j
  const jobId = "job_" + crypto.randomUUID();

  logger.info(
    { jobId, integrationId: input.integrationId, purgeData: input.purgeData, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    "integration.delete: queued (stub)",
  );

  return {
    jobId,
    status: "queued" as const,
    integrationId: input.integrationId,
    purgeData: input.purgeData,
  };
};
