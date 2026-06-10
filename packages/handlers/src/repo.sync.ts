import type { CapabilityHandler } from "@oxagen/oxagen";
import { repoSync } from "@oxagen/oxagen/contracts/repo.sync";
import { logger } from "./logger";

export const repoSyncHandler: CapabilityHandler<typeof repoSync> = async (input, ctx) => {
  // TODO: Implement actual sync via Inngest job (trigger repo pull, diff since cursor)
  const jobId = "job_" + crypto.randomUUID();

  logger.info(
    { jobId, repoId: input.repoId, mode: input.mode, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    "repo.sync: queued (stub)",
  );

  return {
    jobId,
    status: "queued" as const,
    mode: input.mode,
    estimatedRecords: 0,
  };
};
