import { setWorkspaceSecret } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";
import { emitSecurityEvent } from "@oxagen/database/security";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { orgListingId, authKind, secret, accessToken, refreshToken } =
    input as {
      orgListingId: string;
      authKind: "oauth" | "secret";
      secret?: string;
      accessToken?: string;
      refreshToken?: string;
    };

  if (!ctx.workspaceId) {
    throw new Error(
      "[plugin.credential.set_secret] workspaceId is required (scoped capability)",
    );
  }

  try {
    await setWorkspaceSecret({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      orgListingId,
      authKind,
      secret: secret ?? null,
      accessToken: accessToken ?? null,
      refreshToken: refreshToken ?? null,
    });
  } catch (err) {
    logger.error(
      {
        err,
        orgListingId,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        authKind,
      },
      "plugin.credential.set_secret: failed",
    );
    throw err;
  }

  // A plugin's stored OAuth token or secret is a privileged credential, and
  // SOC2 CC6.1 asks that setting or deleting one leave a trail. This handler
  // used to carry an audit-exempt comment saying the taxonomy had no fitting
  // type. It does now (oxagen#2533).
  emitSecurityEvent({
    eventType: "plugin.credential_set",
    actorUserId: ctx.userId ?? null,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    capability: "set_plugin_secret",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });

  logger.info(
    { orgListingId, orgId: ctx.orgId, workspaceId: ctx.workspaceId, authKind },
    "plugin.credential.set_secret: ok",
  );
  return { ok: true };
};
