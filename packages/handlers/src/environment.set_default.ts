import { setDefaultEnvironment } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const environmentSetDefaultHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[environment.set_default] workspaceId is required (scoped capability)",
    );
  const { environmentId } = input as { environmentId: string };
  const environment = await setDefaultEnvironment(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    { environmentId },
  );
  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, environmentId },
    "environment.set_default: ok",
  );
  return { environment };
};
