import { exportSecrets } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

// Privileged + audited (Spec §7.3). The service writes environments.secret_access_log
// on every call. NEVER log the exported values or rendered .env text.
export const secretExportHandler: CapabilityHandlerFn = async (input, ctx) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[secret.export] workspaceId is required (scoped capability)",
    );
  const { environmentId, keyIds } = input as {
    environmentId?: string | null;
    keyIds?: string[] | null;
  };
  try {
    const result = await exportSecrets(
      {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        requestId: ctx.requestId,
      },
      { environmentId: environmentId ?? null, keyIds: keyIds ?? null },
    );
    logger.info(
      {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        environmentId: environmentId ?? null,
        count: result.env.length,
        actorUserId: ctx.userId,
      },
      "secret.export: ok (recorded to access log)",
    );
    return result;
  } catch (err) {
    logger.error(
      {
        err,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        environmentId: environmentId ?? null,
      },
      "secret.export: failed",
    );
    throw err;
  }
};
