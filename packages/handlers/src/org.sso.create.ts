import { randomBytes, randomUUID } from "node:crypto";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { orgSsoCreate } from "@oxagen/oxagen/contracts/org.sso.create";
import { isUniqueViolation, withSystemDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import {
  buildSsoOidcConfig,
  buildSsoSamlConfig,
  discoverOidc,
  refuseSealedSsoInput,
  requireSsoEntitlement,
  requireSsoKms,
  sealSsoConfigOrRefuse,
  ssoAuthBaseUrl,
  ssoSpEntityId,
  toSsoProviderView,
} from "./lib/sso";
import { accountProviderIdInUse, insertOrgSsoProvider } from "./lib/sso-store";
import { logger } from "./logger";

/**
 * create_sso_provider: register an OIDC or SAML identity provider for one
 * email domain (ADR-144).
 *
 * Order matters:
 *   1. The org-role check.
 *   2. Refuse when no KMS is configured, before any network read or write.
 *   3. OIDC only: read the issuer's discovery document, so sign-in never has
 *      to, and refuse an issuer or endpoint on a private address.
 *   4. Build the plugin config from an allowlist, seal its secrets, and check
 *      that no plaintext secret is left.
 *   5. Insert the row, unverified, with a fresh DNS verification token.
 *   6. Emit `sso.provider_created`.
 */
export const orgSsoCreateHandler: CapabilityHandler<
  typeof orgSsoCreate
> = async (input, ctx) => {
  // The org-role check lives here, not only in the contract's `defaultRoles`:
  // the kernel's IAM check allows every human caller in a non-enterprise org
  // (packages/iam/src/check-iam.ts), and a provider decides who can sign in
  // to the organisation (INV-29).
  const actorUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actorUserId },
    { org: ["Owner", "Admin"] },
  );
  // Setting SSO up is part of the Enterprise plan (ADR-144).
  await requireSsoEntitlement(ctx);

  refuseSealedSsoInput(
    orgSsoCreate.name,
    "clientSecret",
    input.config.protocol === "oidc" ? input.config.clientSecret : undefined,
  );
  refuseSealedSsoInput(
    orgSsoCreate.name,
    "spPrivateKey",
    input.config.protocol === "saml" ? input.config.spPrivateKey : undefined,
  );
  const kms = requireSsoKms();
  const baseUrl = ssoAuthBaseUrl();
  const groupsClaim = input.groupsClaim ?? "groups";
  const config = input.config;

  let issuer: string;
  let oidcConfig: string | null = null;
  let samlConfig: string | null = null;
  if (config.protocol === "oidc") {
    const discovery = await discoverOidc(orgSsoCreate.name, config.issuer);
    issuer = discovery.issuer;
    oidcConfig = await sealSsoConfigOrRefuse(
      "oidc",
      buildSsoOidcConfig({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        scopes: config.scopes,
        discovery,
        groupsClaim,
      }),
      kms,
    );
  } else {
    issuer = config.issuer;
    samlConfig = await sealSsoConfigOrRefuse(
      "saml",
      buildSsoSamlConfig({
        issuer: config.issuer,
        entryPoint: config.entryPoint,
        cert: config.cert,
        spPrivateKey: config.spPrivateKey,
        spEntityId: ssoSpEntityId(baseUrl, input.providerId),
        groupsClaim,
      }),
      kms,
    );
  }

  let row;
  try {
    // tenancy: the row is written with organizationId = ctx.orgId after the
    // Owner or Admin membership check above; auth.sso_providers is a
    // shared-plane platform table with no RLS, so the bypass is the only way
    // to write it and the orgId column is the fence.
    row = await withSystemDb(async (tx) => {
      // An id another account source already uses would let this provider's
      // IdP sign in as that source's users (see RESERVED_SSO_PROVIDER_IDS).
      if (await accountProviderIdInUse(tx, input.providerId)) {
        throw new HandlerError({
          code: "conflict",
          reason: "provider_id_reserved",
          message: `The provider id "${input.providerId}" belongs to another sign-in method. Choose another.`,
        });
      }
      return insertOrgSsoProvider(tx, {
        id: randomUUID(),
        issuer,
        oidcConfig,
        samlConfig,
        userId: actorUserId,
        providerId: input.providerId,
        organizationId: ctx.orgId,
        domain: input.domain,
        domainVerified: false,
        protocol: config.protocol,
        displayName: input.displayName,
        groupsClaim,
        domainVerificationToken: randomBytes(24).toString("hex"),
      });
    });
  } catch (err) {
    if (isUniqueViolation(err, "sso_providers_provider_id_idx")) {
      throw new HandlerError({
        code: "conflict",
        reason: "provider_id_taken",
        message: `The provider id "${input.providerId}" is taken. Choose another.`,
      });
    }
    if (isUniqueViolation(err, "sso_providers_domain_idx")) {
      throw new HandlerError({
        code: "conflict",
        reason: "domain_taken",
        message: `The domain ${input.domain} already has an SSO provider. One domain signs in through one provider.`,
      });
    }
    throw err;
  }

  // SOC2 CC6.1: a new identity provider changes who can sign in. The row
  // names the provider and never carries its configuration.
  emitSecurityEvent({
    eventType: "sso.provider_created",
    actorUserId,
    orgId: ctx.orgId,
    workspaceId: null,
    capability: orgSsoCreate.name,
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
    detail: {
      providerId: row.providerId,
      protocol: config.protocol,
      domain: row.domain,
    },
  });

  logger.info(
    {
      orgId: ctx.orgId,
      actorUserId,
      providerId: row.providerId,
      protocol: config.protocol,
      surface: ctx.surface,
    },
    "org.sso.create: SSO provider registered",
  );

  return { provider: toSsoProviderView(row, [], baseUrl) };
};
