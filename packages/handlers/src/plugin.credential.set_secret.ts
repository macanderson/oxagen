import { setWorkspaceSecret } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";

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

  await setWorkspaceSecret({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    orgListingId,
    authKind,
    secret: secret ?? null,
    accessToken: accessToken ?? null,
    refreshToken: refreshToken ?? null,
  });

  return { ok: true };
};
