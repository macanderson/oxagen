import { deleteEnvironment } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const environmentDeleteHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[environment.delete] workspaceId is required (scoped capability)",
    );
  const { environmentId } = input as { environmentId: string };
  const result = await deleteEnvironment(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    { environmentId },
  );
  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, environmentId },
    "environment.delete: ok",
  );
  return result;
};
