import type { CapabilityHandler } from "@oxagen/oxagen";
import { repoPause } from "@oxagen/oxagen/contracts/repo.pause";
import { logger } from "./logger";

export const repoPauseHandler: CapabilityHandler<typeof repoPause> = async (input, ctx) => {
  // TODO: Update connection status to "paused" in Postgres and cancel next scheduled sync
  const now = new Date().toISOString();

  logger.info(
    { repoId: input.repoId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    "repo.pause: paused (stub)",
  );

  return {
    repoId: input.repoId,
    status: "paused" as const,
    pausedAt: now,
  };
};
