import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { orgSsoList } from "@oxagen/oxagen/contracts/org.sso.list";
import { withSystemDb } from "@oxagen/database";
import {
  ssoAuthBaseUrl,
  ssoEntitled,
  toSsoGroupRoles,
  toSsoProviderView,
} from "./lib/sso";
import {
  listOrgSsoGroupRoles,
  listOrgSsoProviders,
  readOrgSsoRequired,
} from "./lib/sso-store";
import {
  readLiveScimToken,
  scimBaseUrl,
  toScimTokenView,
} from "./lib/scim/token-store";

// audit-exempt: read-only listing, no mutation

/**
 * list_sso_providers: the organisation's identity providers, their
 * group-to-role tables and the SSO requirement (ADR-145).
 *
 * Each view is built from the stored row through `redactSsoConfig`, so a
 * secret is reported as set or not set and never read.
 *
 * The list is not gated on the plan. It reports `entitled` instead, so the
 * page can say SSO is part of the Enterprise plan and an organisation that
 * left the plan can still see and delete its providers.
 */
export const orgSsoListHandler: CapabilityHandler<typeof orgSsoList> = async (
  _input,
  ctx,
) => {
  // The org-role check lives here, not only in the contract's `defaultRoles`:
  // the kernel's IAM check allows every human caller in a non-enterprise org
  // (packages/iam/src/check-iam.ts), and a provider list names the domains
  // and client ids an attacker would need (INV-29).
  await assertOrgRole(
    { ...ctx, userId: await resolveActingUserId(ctx) },
    { org: ["Owner", "Admin"] },
  );
  const baseUrl = ssoAuthBaseUrl();
  const entitled = await ssoEntitled(ctx);

  // tenancy: every query is filtered by orgId = ctx.orgId after the Owner or
  // Admin membership check above; auth.sso_providers is a shared-plane table
  // with no RLS, and org.sso_group_roles references it, so both are read on
  // the shared plane in one transaction.
  const { rows, roles, ssoRequired, scimToken } = await withSystemDb(
    async (tx) => {
      const rows = await listOrgSsoProviders(tx, ctx.orgId);
      const roles = await listOrgSsoGroupRoles(
        tx,
        ctx.orgId,
        rows.map((r) => r.providerId),
      );
      const ssoRequired = await readOrgSsoRequired(tx, ctx.orgId);
      const scimToken = await readLiveScimToken(tx, ctx.orgId);
      return { rows, roles, ssoRequired, scimToken };
    },
  );

  return {
    providers: rows.map((row) =>
      toSsoProviderView(row, toSsoGroupRoles(roles, row.providerId), baseUrl),
    ),
    policy: { ssoRequired },
    entitled,
    scim: {
      baseUrl: scimBaseUrl(baseUrl),
      token: scimToken ? toScimTokenView(scimToken) : null,
    },
  };
};
