import type { CapabilityHandler } from "@oxagen/oxagen";
import { repoResume } from "@oxagen/oxagen/contracts/repo.resume";
import { logger } from "./logger";

export const repoResumeHandler: CapabilityHandler<typeof repoResume> = async (input, ctx) => {
  // TODO: Update connection status to "active" in Postgres and schedule next sync
  const now = new Date().toISOString();

  logger.info(
    { repoId: input.repoId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    "repo.resume: resumed (stub)",
  );

  return {
    repoId: input.repoId,
    status: "active" as const,
    resumedAt: now,
    nextSyncAt: null,
  };
};
