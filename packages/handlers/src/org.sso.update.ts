import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { orgSsoUpdate } from "@oxagen/oxagen/contracts/org.sso.update";
import type { SsoProtocolName } from "@oxagen/oxagen/contracts/org.sso.shared";
import { withSystemDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import {
  buildSsoOidcConfig,
  buildSsoSamlConfig,
  discoverOidc,
  parseStoredSsoConfig,
  requireSsoKms,
  sameSsoIssuer,
  sealSsoConfigOrRefuse,
  serializeSealedSsoConfig,
  ssoAuthBaseUrl,
  ssoSpEntityId,
  storedSsoOidcDiscovery,
  toSsoGroupRoles,
  toSsoProviderView,
  withSsoGroupsClaim,
  type SsoProviderRow,
} from "./lib/sso";
import {
  findOrgSsoProvider,
  listOrgSsoGroupRoles,
  updateOrgSsoProvider,
} from "./lib/sso-store";
import { logger } from "./logger";

function notFound(providerId: string): HandlerError {
  return new HandlerError({
    code: "not_found",
    reason: "sso_provider_not_found",
    message: `This organisation has no SSO provider "${providerId}".`,
  });
}

/**
 * update_sso_provider: change a provider's display name, groups claim or
 * protocol settings (ADR-142).
 *
 * A secret left out of `config` keeps the sealed token already stored: the
 * stored config is parsed, never opened, and `sealSsoConfig` skips a value
 * that is already sealed. The domain cannot change and the protocol must
 * match. A new OIDC issuer is checked against its discovery document; an
 * unchanged one keeps the endpoints read at registration.
 */
export const orgSsoUpdateHandler: CapabilityHandler<
  typeof orgSsoUpdate
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

  // tenancy: the provider is read by providerId and filtered by orgId =
  // ctx.orgId after the Owner or Admin membership check above; another
  // organisation's provider reads as not found.
  const row = await withSystemDb((tx) =>
    findOrgSsoProvider(tx, ctx.orgId, input.providerId),
  );
  if (!row) throw notFound(input.providerId);

  const protocol = row.protocol as SsoProtocolName;
  const changedFields: string[] = [];
  const patch: Partial<SsoProviderRow> = {};

  if (
    input.displayName !== undefined &&
    input.displayName !== row.displayName
  ) {
    patch.displayName = input.displayName;
    changedFields.push("displayName");
  }
  const groupsClaim = input.groupsClaim ?? row.groupsClaim;
  const groupsClaimChanged = groupsClaim !== row.groupsClaim;
  if (groupsClaimChanged) {
    patch.groupsClaim = groupsClaim;
    changedFields.push("groupsClaim");
  }

  const stored = parseStoredSsoConfig(
    protocol === "oidc" ? row.oidcConfig : row.samlConfig,
  );
  const config = input.config;
  if (config) {
    if (config.protocol !== protocol) {
      throw new CapabilityError(
        orgSsoUpdate.name,
        "invalid_input",
        `This provider uses ${protocol.toUpperCase()}. To switch to ${config.protocol.toUpperCase()}, delete it and create a new one.`,
      );
    }
    const kms = requireSsoKms();
    if (config.protocol === "oidc") {
      const clientSecret =
        config.clientSecret ??
        (typeof stored["clientSecret"] === "string"
          ? (stored["clientSecret"] as string)
          : undefined);
      if (!clientSecret) {
        throw new CapabilityError(
          orgSsoUpdate.name,
          "invalid_input",
          "No client secret is stored for this provider. Enter the client secret.",
        );
      }
      const discovery =
        (sameSsoIssuer(config.issuer, row.issuer)
          ? storedSsoOidcDiscovery(stored, row.issuer)
          : null) ?? (await discoverOidc(orgSsoUpdate.name, config.issuer));
      patch.issuer = discovery.issuer;
      patch.oidcConfig = await sealSsoConfigOrRefuse(
        "oidc",
        buildSsoOidcConfig({
          clientId: config.clientId,
          clientSecret,
          scopes: config.scopes,
          discovery,
          groupsClaim,
        }),
        kms,
      );
    } else {
      const spPrivateKey =
        config.spPrivateKey ??
        (typeof stored["privateKey"] === "string"
          ? (stored["privateKey"] as string)
          : undefined);
      patch.issuer = config.issuer;
      patch.samlConfig = await sealSsoConfigOrRefuse(
        "saml",
        buildSsoSamlConfig({
          issuer: config.issuer,
          entryPoint: config.entryPoint,
          cert: config.cert,
          spPrivateKey,
          spEntityId: ssoSpEntityId(ssoAuthBaseUrl(), row.providerId),
          groupsClaim,
        }),
        kms,
      );
    }
    // Sending the settings already stored is not a change: a kept secret
    // reuses its sealed token, so the rebuilt text matches the column.
    const column = protocol === "oidc" ? "oidcConfig" : "samlConfig";
    if (patch[column] === row[column] && patch.issuer === row.issuer) {
      delete patch[column];
      delete patch.issuer;
    } else {
      changedFields.push("config");
    }
  } else if (groupsClaimChanged) {
    // The claim is also inside the stored config, where the plugin reads it.
    // Rewriting that one field leaves every sealed secret as it is.
    const next = serializeSealedSsoConfig(
      protocol,
      withSsoGroupsClaim(stored, groupsClaim),
    );
    if (protocol === "oidc") patch.oidcConfig = next;
    else patch.samlConfig = next;
  }

  const baseUrl = ssoAuthBaseUrl();
  // tenancy: the update and the group-role read are filtered by orgId =
  // ctx.orgId after the Owner or Admin membership check above, on the shared
  // plane where auth.sso_providers lives.
  const result = await withSystemDb(async (tx) => {
    const updated =
      changedFields.length > 0
        ? await updateOrgSsoProvider(tx, ctx.orgId, row.providerId, patch)
        : row;
    if (!updated) return null;
    const roles = await listOrgSsoGroupRoles(tx, ctx.orgId, [row.providerId]);
    return { updated, roles };
  });
  if (!result) throw notFound(input.providerId);

  if (changedFields.length > 0) {
    // SOC2 CC6.1: a changed provider changes how people sign in. The row
    // names the fields that changed and never their values.
    emitSecurityEvent({
      eventType: "sso.provider_updated",
      actorUserId,
      orgId: ctx.orgId,
      workspaceId: null,
      capability: orgSsoUpdate.name,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
      detail: {
        providerId: row.providerId,
        protocol,
        domain: row.domain,
        changedFields,
      },
    });
    logger.info(
      {
        orgId: ctx.orgId,
        actorUserId,
        providerId: row.providerId,
        changedFields,
        surface: ctx.surface,
      },
      "org.sso.update: SSO provider updated",
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
