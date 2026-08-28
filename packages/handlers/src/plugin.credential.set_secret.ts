// audit-exempt: stores a plugin OAuth/secret credential. No fitting security-event type exists in the current taxonomy (there is no plugin.credential_* family). The write itself goes through the @oxagen/plugins KMS-wrapping seam (its own envelope-encryption audit) and the kernel capability.invoke_* audit records the privileged invocation. Re-evaluate when a plugin.credential.* taxonomy is added.
import { setWorkspaceSecret } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

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

  logger.info(
    { orgListingId, orgId: ctx.orgId, workspaceId: ctx.workspaceId, authKind },
    "plugin.credential.set_secret: ok",
  );
  return { ok: true };
};
