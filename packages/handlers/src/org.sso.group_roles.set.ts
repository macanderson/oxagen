import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { orgSsoGroupRolesSet } from "@oxagen/oxagen/contracts/org.sso.group_roles.set";
import { withSystemDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { findOrgSsoProvider, replaceOrgSsoGroupRoles } from "./lib/sso-store";
import { logger } from "./logger";

/**
 * set_sso_group_roles: replace a provider's IdP group to organisation role
 * table (ADR-142).
 *
 * The rows sent are the rows kept: the old table is deleted and the new one
 * inserted in one transaction, so a sign-in never sees half of each.
 */
export const orgSsoGroupRolesSetHandler: CapabilityHandler<
  typeof orgSsoGroupRolesSet
> = async (input, ctx) => {
  // The org-role check lives here, not only in the contract's `defaultRoles`:
  // the kernel's IAM check allows every human caller in a non-enterprise org
  // (packages/iam/src/check-iam.ts), and this table decides which role an
  // IdP group grants, Admin included (INV-29).
  const actorUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actorUserId },
    { org: ["Owner", "Admin"] },
  );

  // tenancy: the provider lookup, delete and insert are all filtered by
  // orgId = ctx.orgId after the Owner or Admin membership check above.
  // org.sso_group_roles has a foreign key into auth.sso_providers, a
  // shared-plane table, so the rows are written on the shared plane too; the
  // sign-in provisioner reads them there with no tenant scope.
  const found = await withSystemDb(async (tx) => {
    const provider = await findOrgSsoProvider(tx, ctx.orgId, input.providerId);
    if (!provider) return false;
    await replaceOrgSsoGroupRoles(
      tx,
      ctx.orgId,
      input.providerId,
      input.mappings,
      actorUserId,
    );
    return true;
  });
  if (!found) {
    throw new HandlerError({
      code: "not_found",
      reason: "sso_provider_not_found",
      message: `This organisation has no SSO provider "${input.providerId}".`,
    });
  }

  const mappings = input.mappings.map((m) => ({
    group: m.group,
    role: m.role,
  }));

  // SOC2 CC6.1: the table decides which role each IdP group grants. The row
  // holds the table after the write.
  emitSecurityEvent({
    eventType: "sso.group_roles_set",
    actorUserId,
    orgId: ctx.orgId,
    workspaceId: null,
    capability: orgSsoGroupRolesSet.name,
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
    detail: { providerId: input.providerId, mappings },
  });

  logger.info(
    {
      orgId: ctx.orgId,
      actorUserId,
      providerId: input.providerId,
      mappings: mappings.length,
      surface: ctx.surface,
    },
    "org.sso.group_roles.set: SSO group roles replaced",
  );

  return { providerId: input.providerId, mappings };
};
