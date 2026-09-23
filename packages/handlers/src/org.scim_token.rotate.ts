import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { orgScimTokenRotate } from "@oxagen/oxagen/contracts/org.scim_token.rotate";
import { withSystemDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { requireSsoEntitlement, ssoAuthBaseUrl } from "./lib/sso";
import {
  insertScimToken,
  revokeLiveScimToken,
  scimBaseUrl,
  toScimTokenView,
} from "./lib/scim/token-store";
import { logger } from "./logger";

/**
 * rotate_scim_token: revoke the live SCIM token and mint its replacement in
 * one transaction (#3734). The old token stops authenticating when this
 * commits. With no live token it simply mints one, so a token nobody wrote
 * down is recovered the same way.
 */
export const orgScimTokenRotateHandler: CapabilityHandler<
  typeof orgScimTokenRotate
> = async (_input, ctx) => {
  const actorUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actorUserId },
    { org: ["Owner", "Admin"] },
  );
  await requireSsoEntitlement(ctx);
  const actor = actorUserId as string;

  // tenancy: every statement is filtered by orgId = ctx.orgId after the Owner
  // or Admin check above, on the shared plane where the SCIM route reads it.
  const { previous, minted } = await withSystemDb(async (tx) => {
    const previous = await revokeLiveScimToken(tx, ctx.orgId, actor);
    const minted = await insertScimToken(tx, ctx.orgId, actor);
    return { previous, minted };
  });

  emitSecurityEvent({
    eventType: "scim.token_rotated",
    actorUserId: actor,
    orgId: ctx.orgId,
    workspaceId: null,
    capability: orgScimTokenRotate.name,
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
    detail: { tokenPrefix: minted.row.tokenPrefix },
  });
  logger.info(
    {
      orgId: ctx.orgId,
      actorUserId: actor,
      replaced: previous?.tokenPrefix ?? null,
      surface: ctx.surface,
    },
    "org.scim_token.rotate: SCIM token rotated",
  );

  return {
    token: minted.token,
    baseUrl: scimBaseUrl(ssoAuthBaseUrl()),
    view: toScimTokenView(minted.row),
  };
};
