import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { orgSsoVerifyDomain } from "@oxagen/oxagen/contracts/org.sso.verify_domain";
import {
  ssoVerificationRecordName,
  ssoVerificationRecordValue,
} from "@oxagen/oxagen/contracts/org.sso.shared";
import { withSystemDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import {
  requireSsoEntitlement,
  ssoAuthBaseUrl,
  ssoResolveTxt,
  toSsoGroupRoles,
  toSsoProviderView,
} from "./lib/sso";
import {
  findOrgSsoProvider,
  listOrgSsoGroupRoles,
  updateOrgSsoProvider,
} from "./lib/sso-store";
import { logger } from "./logger";

/** DNS answers that mean "no such record", as opposed to a resolver failure. */
const DNS_NOT_FOUND_CODES = new Set(["ENOTFOUND", "ENODATA", "ENOTIMP"]);

/**
 * The TXT strings published at `name`. A record split into several chunks
 * (a TXT string longer than 255 bytes) is joined back into one value. An
 * absent record is an empty list; any other resolver error is thrown.
 */
async function publishedTxtValues(name: string): Promise<string[]> {
  try {
    const records = await ssoResolveTxt(name);
    return records.map((chunks) => chunks.join(""));
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && DNS_NOT_FOUND_CODES.has(code)) return [];
    throw err;
  }
}

/**
 * verify_sso_domain: mark a provider's domain verified once the DNS TXT
 * record its view names is published (ADR-145).
 *
 * The match is exact: the record name is `_oxagen-sso.<domain>` and one of
 * its TXT values must equal `oxagen-sso-verification=<token>`. A miss is a
 * `conflict` naming the record to publish. Verifying an already verified
 * domain looks the record up again and succeeds without a second audit row.
 */
export const orgSsoVerifyDomainHandler: CapabilityHandler<
  typeof orgSsoVerifyDomain
> = async (input, ctx) => {
  // The org-role check lives here, not only in the contract's `defaultRoles`:
  // the kernel's IAM check allows every human caller in a non-enterprise org
  // (packages/iam/src/check-iam.ts), and a verified domain is what lets a
  // provider sign people in (INV-29).
  const actorUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actorUserId },
    { org: ["Owner", "Admin"] },
  );
  // Setting SSO up is part of the Enterprise plan (ADR-145).
  await requireSsoEntitlement(ctx);

  // tenancy: the provider is read by providerId and filtered by orgId =
  // ctx.orgId after the Owner or Admin membership check above; another
  // organisation's provider reads as not found.
  const row = await withSystemDb((tx) =>
    findOrgSsoProvider(tx, ctx.orgId, input.providerId),
  );
  if (!row) {
    throw new HandlerError({
      code: "not_found",
      reason: "sso_provider_not_found",
      message: `This organisation has no SSO provider "${input.providerId}".`,
    });
  }

  const recordName = ssoVerificationRecordName(row.domain);
  const recordValue = ssoVerificationRecordValue(row.domainVerificationToken);
  const values = await publishedTxtValues(recordName);
  if (!values.includes(recordValue)) {
    throw new HandlerError({
      code: "conflict",
      reason: "dns_record_not_found",
      message: `No matching TXT record at ${recordName}. Publish a TXT record there with the value ${recordValue}, wait for DNS to update, then verify again.`,
    });
  }

  const wasVerified = row.domainVerified;
  const baseUrl = ssoAuthBaseUrl();
  // tenancy: the update and the group-role read are filtered by orgId =
  // ctx.orgId after the Owner or Admin membership check above, on the shared
  // plane where auth.sso_providers lives.
  const result = await withSystemDb(async (tx) => {
    const updated = wasVerified
      ? row
      : await updateOrgSsoProvider(tx, ctx.orgId, row.providerId, {
          domainVerified: true,
        });
    if (!updated) return null;
    const roles = await listOrgSsoGroupRoles(tx, ctx.orgId, [row.providerId]);
    return { updated, roles };
  });
  if (!result) {
    throw new HandlerError({
      code: "not_found",
      reason: "sso_provider_not_found",
      message: `This organisation has no SSO provider "${input.providerId}".`,
    });
  }

  if (!wasVerified) {
    // SOC2 CC6.1: from this point the provider can sign people in.
    emitSecurityEvent({
      eventType: "sso.domain_verified",
      actorUserId,
      orgId: ctx.orgId,
      workspaceId: null,
      capability: orgSsoVerifyDomain.name,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
      detail: {
        providerId: row.providerId,
        protocol: row.protocol as "oidc" | "saml",
        domain: row.domain,
      },
    });
    logger.info(
      {
        orgId: ctx.orgId,
        actorUserId,
        providerId: row.providerId,
        surface: ctx.surface,
      },
      "org.sso.verify_domain: SSO domain verified",
    );
  }

  return {
    provider: toSsoProviderView(
      result.updated,
      toSsoGroupRoles(result.roles, row.providerId),
      baseUrl,
    ),
  };
};
