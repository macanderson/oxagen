import type { CapabilityHandler } from "@oxagen/oxagen";
import { repoConfigure } from "@oxagen/oxagen/contracts/repo.configure";
import { logger } from "./logger";

export const repoConfigureHandler: CapabilityHandler<typeof repoConfigure> = async (input, ctx) => {
  // TODO: Persist repo config to Postgres connection record and trigger re-index if needed
  const now = new Date().toISOString();

  logger.info(
    { repoId: input.repoId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    "repo.configure: updated (stub)",
  );

  return {
    repoId: input.repoId,
    displayName: input.repoId,
    recordTypes: input.recordTypes ?? ["pull_request", "issue", "commit"],
    pathFilters: input.pathFilters
      ? {
          include: input.pathFilters.include ?? [],
          exclude: input.pathFilters.exclude ?? [],
        }
      : null,
    labelFilters: input.labelFilters
      ? {
          include: input.labelFilters.include ?? [],
          exclude: input.labelFilters.exclude ?? [],
        }
      : null,
    inferenceEnabled: input.inferenceEnabled ?? false,
    syncCadence: input.syncCadence ?? "manual",
    pollingIntervalSeconds: input.pollingIntervalSeconds ?? null,
    updatedAt: now,
  };
};
