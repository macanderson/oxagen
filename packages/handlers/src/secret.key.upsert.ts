import { upsertSecretKey } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const secretKeyUpsertHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[secret.key.upsert] workspaceId is required (scoped capability)",
    );
  const { key, sensitive, memo, defaultValue } = input as {
    key: string;
    sensitive: boolean;
    memo?: string | null;
    defaultValue?: string | null;
  };
  // NEVER log the value — key name + sensitive flag only.
  const result = await upsertSecretKey(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    { key, sensitive, memo, defaultValue },
  );
  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, key, sensitive },
    "secret.key.upsert: ok",
  );
  return result;
};
