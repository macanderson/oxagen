import { upsertSecretKey } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";
import { emitSecurityEvent } from "@oxagen/database/security";

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
  // Upsert takes a defaultValue, so this can write secret material and not
  // only declare a key name. Auditing every upsert rather than only the ones
  // carrying a value keeps the rule readable and errs toward recording.
  emitSecurityEvent({
    eventType: "secret.value_changed",
    actorUserId: ctx.userId ?? null,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    capability: "upsert_secret_key",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });
  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, key, sensitive },
    "secret.key.upsert: ok",
  );
  return result;
};
