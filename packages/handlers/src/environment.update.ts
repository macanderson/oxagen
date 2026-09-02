import { updateEnvironment } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const environmentUpdateHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[environment.update] workspaceId is required (scoped capability)",
    );
  const { environmentId, name, slug, description, isActive } = input as {
    environmentId: string;
    name?: string;
    slug?: string;
    description?: string | null;
    isActive?: boolean;
  };
  const environment = await updateEnvironment(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    { environmentId, name, slug, description, isActive },
  );
  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, environmentId },
    "environment.update: ok",
  );
  return { environment };
};
