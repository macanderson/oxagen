import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { orgScimTokenCreate } from "@oxagen/oxagen/contracts/org.scim_token.create";
import { withSystemDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { requireSsoEntitlement, ssoAuthBaseUrl } from "./lib/sso";
import {
  insertScimToken,
  readLiveScimToken,
  scimBaseUrl,
  toScimTokenView,
} from "./lib/scim/token-store";
import { logger } from "./logger";

/**
 * create_scim_token: mint the organization's SCIM bearer token (#3734).
 *
 * The token is answered once and only its hash is stored. A live token makes
 * this a conflict, so an admin cannot mint a second token by accident and
 * leave the first one working; `rotate_scim_token` replaces one on purpose.
 * The partial unique index `scim_tokens_org_live_idx` holds the same line
 * against two concurrent mints.
 */
export const orgScimTokenCreateHandler: CapabilityHandler<
  typeof orgScimTokenCreate
> = async (_input, ctx) => {
  // The org-role check lives here as well as in `defaultRoles`: the kernel's
  // IAM check allows every human caller in a non-enterprise org, and this
  // token can remove every member of the organization (INV-29).
  const actorUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actorUserId },
    { org: ["Owner", "Admin"] },
  );
  await requireSsoEntitlement(ctx);
  // assertOrgRole refused a call with no acting user.
  const actor = actorUserId as string;

  // tenancy: every statement is filtered by orgId = ctx.orgId after the Owner
  // or Admin check above; org.scim_tokens is read on the shared plane, where
  // the SCIM route resolves it before any tenant scope exists.
  const minted = await withSystemDb(async (tx) => {
    if (await readLiveScimToken(tx, ctx.orgId, true)) return null;
    return insertScimToken(tx, ctx.orgId, actor);
  });
  if (!minted) {
    throw new HandlerError({
      code: "conflict",
      reason: "scim_token_exists",
      message:
        "The organization already has a SCIM token. Rotate it to get a new one.",
    });
  }

  // SOC2 CC6.1: this credential can create and remove members.
  emitSecurityEvent({
    eventType: "scim.token_created",
    actorUserId: actor,
    orgId: ctx.orgId,
    workspaceId: null,
    capability: orgScimTokenCreate.name,
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
    detail: { tokenPrefix: minted.row.tokenPrefix },
  });
  logger.info(
    { orgId: ctx.orgId, actorUserId: actor, surface: ctx.surface },
    "org.scim_token.create: SCIM token minted",
  );

  return {
    token: minted.token,
    baseUrl: scimBaseUrl(ssoAuthBaseUrl()),
    view: toScimTokenView(minted.row),
  };
};
