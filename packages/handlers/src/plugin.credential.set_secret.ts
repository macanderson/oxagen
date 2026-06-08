import { setWorkspaceSecret } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { orgListingId, authKind, secret, accessToken, refreshToken } = input as {
    orgListingId: string;
    authKind: "oauth" | "secret";
    secret?: string;
    accessToken?: string;
    refreshToken?: string;
  };

  if (!ctx.workspaceId) {
    throw new Error("[plugin.credential.set_secret] workspaceId is required (scoped capability)");
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
      { err, orgListingId, orgId: ctx.orgId, workspaceId: ctx.workspaceId, authKind },
      "plugin.credential.set_secret: failed",
    );
    throw err;
  }

  logger.info(
    { orgListingId, orgId: ctx.orgId, workspaceId: ctx.workspaceId, authKind },
    "plugin.credential.set_secret: ok",
  );
  return { ok: true };
};
