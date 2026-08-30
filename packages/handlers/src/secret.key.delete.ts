import { deleteSecretKey } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const secretKeyDeleteHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[secret.key.delete] workspaceId is required (scoped capability)",
    );
  const { keyId } = input as { keyId: string };
  const result = await deleteSecretKey(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    { keyId },
  );
  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, keyId },
    "secret.key.delete: ok",
  );
  return result;
};
