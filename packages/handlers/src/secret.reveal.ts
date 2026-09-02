import { revealSecret } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

// Privileged + audited (Spec §7.3). The service writes environments.secret_access_log
// on every call. Owner/Admin enforcement comes from the contract's IAM gate on
// the api/mcp surfaces; app call sites must add an explicit gate (apps/app does
// not bootstrap IAM). NEVER log the revealed value.
export const secretRevealHandler: CapabilityHandlerFn = async (input, ctx) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[secret.reveal] workspaceId is required (scoped capability)",
    );
  const { keyId, environmentId } = input as {
    keyId: string;
    environmentId?: string | null;
  };
  try {
    const result = await revealSecret(
      {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        requestId: ctx.requestId,
      },
      { keyId, environmentId: environmentId ?? null },
    );
    logger.info(
      {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        keyId,
        environmentId: environmentId ?? null,
        source: result.source,
        actorUserId: ctx.userId,
      },
      "secret.reveal: ok (recorded to access log)",
    );
    return { key: result.key, value: result.value, source: result.source };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, keyId },
      "secret.reveal: failed",
    );
    throw err;
  }
};
