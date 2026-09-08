import { setSecretValue } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";
import { emitSecurityEvent } from "@oxagen/database/security";

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
  // Changing a secret's value wrote nothing to any audit surface before this:
  // secret_access_log records reads, not writes. This row is the only trace.
  emitSecurityEvent({
    eventType: "secret.value_changed",
    actorUserId: ctx.userId ?? null,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    capability: "set_secret_value",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });
  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, keyId, environmentId },
    "secret.value.set: ok",
  );
  return result;
};
