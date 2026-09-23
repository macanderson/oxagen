import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { orgSsoPolicySet } from "@oxagen/oxagen/contracts/org.sso.policy.set";
import { withSystemDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { requireSsoEntitlement } from "./lib/sso";
import {
  countVerifiedOrgSsoProviders,
  upsertOrgSsoRequired,
} from "./lib/sso-store";
import { logger } from "./logger";

/**
 * set_sso_policy: require SSO for the organisation, or stop requiring it
 * (ADR-145).
 *
 * Turning it on needs a provider whose domain is verified, checked in the
 * same transaction as the write, so a provider deleted a moment earlier
 * cannot leave the organisation requiring a sign-in nobody can complete.
 */
export const orgSsoPolicySetHandler: CapabilityHandler<
  typeof orgSsoPolicySet
> = async (input, ctx) => {
  // The org-role check lives here, not only in the contract's `defaultRoles`:
  // the kernel's IAM check allows every human caller in a non-enterprise org
  // (packages/iam/src/check-iam.ts), and this setting decides how every
  // member signs in (INV-29).
  const actorUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actorUserId },
    { org: ["Owner", "Admin"] },
  );
  // Requiring SSO is part of the Enterprise plan (ADR-145). Turning it off
  // stays open, so an organisation that left the plan is not held to it.
  if (input.ssoRequired) await requireSsoEntitlement(ctx);

  // tenancy: the provider count and the policy upsert are filtered by orgId =
  // ctx.orgId after the Owner or Admin membership check above; they share
  // one transaction on the shared plane, where auth.sso_providers lives.
  const allowed = await withSystemDb(async (tx) => {
    if (
      input.ssoRequired &&
      (await countVerifiedOrgSsoProviders(tx, ctx.orgId)) === 0
    ) {
      return false;
    }
    await upsertOrgSsoRequired(tx, ctx.orgId, input.ssoRequired, actorUserId);
    return true;
  });
  if (!allowed) {
    throw new HandlerError({
      code: "conflict",
      reason: "no_verified_provider",
      message:
        "Verify the domain of at least one SSO provider before requiring SSO.",
    });
  }

  // SOC2 CC6.1: this setting decides how every member signs in.
  emitSecurityEvent({
    eventType: "sso.policy_updated",
    actorUserId,
    orgId: ctx.orgId,
    workspaceId: null,
    capability: orgSsoPolicySet.name,
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
    detail: { ssoRequired: input.ssoRequired },
  });

  logger.info(
    {
      orgId: ctx.orgId,
      actorUserId,
      ssoRequired: input.ssoRequired,
      surface: ctx.surface,
    },
    "org.sso.policy.set: SSO requirement updated",
  );

  return { policy: { ssoRequired: input.ssoRequired } };
};
