import { setSecretValue } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const secretValueSetHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[secret.value.set] workspaceId is required (scoped capability)",
    );
  const { keyId, environmentId, value } = input as {
    keyId: string;
    environmentId: string;
    value: string;
  };
  // NEVER log `value`.
  const result = await setSecretValue(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    { keyId, environmentId, value },
  );
  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, keyId, environmentId },
    "secret.value.set: ok",
  );
  return result;
};
