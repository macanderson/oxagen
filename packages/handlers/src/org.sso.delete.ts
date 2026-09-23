import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { orgSsoDelete } from "@oxagen/oxagen/contracts/org.sso.delete";
import { withSystemDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import {
  countVerifiedOrgSsoProviders,
  deleteOrgSsoProvider,
  readOrgSsoRequired,
  upsertOrgSsoRequired,
} from "./lib/sso-store";
import { logger } from "./logger";

/**
 * delete_sso_provider: remove an identity provider and its group-to-role
 * table (ADR-145).
 *
 * When SSO is required and no verified provider remains, the requirement is
 * turned off in the same transaction as the delete. Otherwise every member
 * but the Owners would be locked out behind a sign-in path that no longer
 * exists. That change emits its own `sso.policy_updated` row.
 */
export const orgSsoDeleteHandler: CapabilityHandler<
  typeof orgSsoDelete
> = async (input, ctx) => {
  // The org-role check lives here, not only in the contract's `defaultRoles`:
  // the kernel's IAM check allows every human caller in a non-enterprise org
  // (packages/iam/src/check-iam.ts), and removing a provider removes a way
  // in to the organisation (INV-29).
  const actorUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actorUserId },
    { org: ["Owner", "Admin"] },
  );

  // tenancy: the delete and the policy write are filtered by orgId =
  // ctx.orgId after the Owner or Admin membership check above; they share one
  // transaction on the shared plane, where auth.sso_providers lives, so the
  // requirement never outlives the organisation's last verified provider.
  const result = await withSystemDb(async (tx) => {
    const deleted = await deleteOrgSsoProvider(tx, ctx.orgId, input.providerId);
    if (!deleted) return null;
    let policyTurnedOff = false;
    if (
      (await readOrgSsoRequired(tx, ctx.orgId)) &&
      (await countVerifiedOrgSsoProviders(tx, ctx.orgId)) === 0
    ) {
      await upsertOrgSsoRequired(tx, ctx.orgId, false, actorUserId);
      policyTurnedOff = true;
    }
    return { deleted, policyTurnedOff };
  });
  if (!result) {
    throw new HandlerError({
      code: "not_found",
      reason: "sso_provider_not_found",
      message: `This organisation has no SSO provider "${input.providerId}".`,
    });
  }
  const { deleted, policyTurnedOff } = result;

  // SOC2 CC6.1: removing a provider changes how people sign in.
  emitSecurityEvent({
    eventType: "sso.provider_deleted",
    actorUserId,
    orgId: ctx.orgId,
    workspaceId: null,
    capability: orgSsoDelete.name,
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
    detail: {
      providerId: deleted.providerId,
      protocol: deleted.protocol as "oidc" | "saml",
      domain: deleted.domain,
    },
  });
  if (policyTurnedOff) {
    emitSecurityEvent({
      eventType: "sso.policy_updated",
      actorUserId,
      orgId: ctx.orgId,
      workspaceId: null,
      capability: orgSsoDelete.name,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
      detail: { ssoRequired: false },
    });
  }

  logger.info(
    {
      orgId: ctx.orgId,
      actorUserId,
      providerId: deleted.providerId,
      policyTurnedOff,
      surface: ctx.surface,
    },
    "org.sso.delete: SSO provider deleted",
  );

  return { deleted: true as const };
};
