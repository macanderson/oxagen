import { getEnvironment } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";

export const environmentGetHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[environment.get] workspaceId is required (scoped capability)",
    );
  const { environmentId } = input as { environmentId: string };
  const environment = await getEnvironment(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    { environmentId },
  );
  return { environment };
};
