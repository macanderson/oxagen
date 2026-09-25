import { unsetSecretValue } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { secretValueUnset } from "@oxagen/oxagen/contracts/secret.value.unset";
import { assertContractRole } from "./lib/capability-role-guard";
import { logger } from "./logger";
import { emitSecurityEvent } from "@oxagen/database/security";

export const secretValueUnsetHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[secret.value.unset] workspaceId is required (scoped capability)",
    );
  // The kernel's IAM check allows every capability for a non-enterprise org,
  // so the handler asks for the contract's roles itself (INV-29, #4194).
  await assertContractRole(secretValueUnset, ctx);
  const { keyId, environmentId } = input as {
    keyId: string;
    environmentId: string;
  };
  const result = await unsetSecretValue(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    { keyId, environmentId },
  );
  // Removing a value is a change to secret material, so it belongs in the
  // same family as setting one. `capability` is what tells the two apart in a
  // query -- unset_secret_value rather than set_secret_value.
  emitSecurityEvent({
    eventType: "secret.value_changed",
    actorUserId: ctx.userId ?? null,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    capability: "unset_secret_value",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });
  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, keyId, environmentId },
    "secret.value.unset: ok",
  );
  return result;
};
