import { deleteSecretKey } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";
import { emitSecurityEvent } from "@oxagen/database/security";

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
  // Deleting a secret key wrote nothing to any audit surface before this:
  // secret_access_log records reads, not writes. This row is the only trace.
  emitSecurityEvent({
    eventType: "secret.key_deleted",
    actorUserId: ctx.userId ?? null,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    capability: "delete_secret_key",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });
  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, keyId },
    "secret.key.delete: ok",
  );
  return result;
};
