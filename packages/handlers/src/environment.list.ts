import { listEnvironments } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";

export const environmentListHandler: CapabilityHandlerFn = async (
  _input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[environment.list] workspaceId is required (scoped capability)",
    );
  const environments = await listEnvironments({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
  });
  return { environments };
};
