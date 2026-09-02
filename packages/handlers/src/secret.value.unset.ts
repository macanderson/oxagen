import { unsetSecretValue } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const secretValueUnsetHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[secret.value.unset] workspaceId is required (scoped capability)",
    );
  const { keyId, environmentId } = input as {
    keyId: string;
    environmentId: string;
  };
  const result = await unsetSecretValue(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    { keyId, environmentId },
  );
  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, keyId, environmentId },
    "secret.value.unset: ok",
  );
  return result;
};
