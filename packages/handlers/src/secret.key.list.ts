import { listSecretKeys } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";

export const secretKeyListHandler: CapabilityHandlerFn = async (
  _input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[secret.key.list] workspaceId is required (scoped capability)",
    );
  const keys = await listSecretKeys({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
  });
  return { keys };
};
