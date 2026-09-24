import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { orgScimTokenRevoke } from "@oxagen/oxagen/contracts/org.scim_token.revoke";
import { withSystemDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { revokeLiveScimToken } from "./lib/scim/token-store";
import { logger } from "./logger";

/**
 * revoke_scim_token: stop the identity provider pushing to Oxagen (#3734).
 * Open on every plan, like deleting an SSO provider, so an organization that
 * left the Enterprise plan can turn SCIM off.
 */
export const orgScimTokenRevokeHandler: CapabilityHandler<
  typeof orgScimTokenRevoke
> = async (_input, ctx) => {
  const actorUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actorUserId },
    { org: ["Owner", "Admin"] },
  );
  const actor = actorUserId as string;

  // tenancy: filtered by orgId = ctx.orgId after the Owner or Admin check
  // above, on the shared plane where the SCIM route reads it.
  const revoked = await withSystemDb((tx) =>
    revokeLiveScimToken(tx, ctx.orgId, actor),
  );
  if (!revoked) return { revoked: false };

  emitSecurityEvent({
    eventType: "scim.token_revoked",
    actorUserId: actor,
    orgId: ctx.orgId,
    workspaceId: null,
    capability: orgScimTokenRevoke.name,
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
    detail: { tokenPrefix: revoked.tokenPrefix },
  });
  logger.info(
    { orgId: ctx.orgId, actorUserId: actor, surface: ctx.surface },
    "org.scim_token.revoke: SCIM token revoked",
  );
  return { revoked: true };
};
