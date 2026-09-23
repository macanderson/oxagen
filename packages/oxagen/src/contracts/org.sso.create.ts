import { z } from "zod";
import {
  assertPublicHttpUrl,
  UnsafeOutboundUrlError,
} from "@oxagen/config/public-url";
import { registerCapability } from "../registry";
import {
  ssoDomainSchema,
  ssoGroupsClaimSchema,
  ssoProtocolInputSchema,
  ssoProviderIdSchema,
  ssoProviderViewSchema,
} from "./org.sso.shared";

/**
 * Refuse an OIDC issuer the server must not fetch. Registration reads the
 * issuer's discovery document from this process, so an issuer on loopback,
 * RFC1918 or the metadata address is a request forgery, not a typo. The
 * check runs in the contract so the refusal is `invalid_input` (a 400) on
 * every surface; the handler repeats it as a backstop.
 */
export function refineSsoIssuer(
  config: { protocol: "oidc" | "saml"; issuer: string },
  issues: z.RefinementCtx,
): void {
  if (config.protocol !== "oidc") return;
  try {
    assertPublicHttpUrl(config.issuer, {
      refusing: "Refusing to register SSO provider",
      requireTls: true,
    });
  } catch (err) {
    if (!(err instanceof UnsafeOutboundUrlError)) throw err;
    issues.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["issuer"],
      message: err.message,
    });
  }
}

/**
 * create_sso_provider: register an OIDC or SAML identity provider for one
 * email domain (ADR-145).
 *
 * For OIDC the handler reads the issuer's discovery document now, so sign-in
 * never has to. Every secret (the OIDC client secret, the SAML SP private
 * key) is sealed with the KMS envelope before the row is written, and the
 * call is refused when no KMS is configured. The provider starts unverified:
 * nobody signs in through it until `verify_sso_domain` finds the DNS TXT
 * record the view names.
 *
 * Org Owner/Admin only, audited as `sso.provider_created`. No `agent`
 * metadata: the in-app agent never reconfigures sign-in.
 */
export const orgSsoCreate = registerCapability({
  name: "create_sso_provider",
  domain: "org",
  description:
    "Register an SSO identity provider (OIDC or SAML) for one email domain. OIDC settings are checked against the issuer's discovery document. Secrets are envelope-encrypted and never readable back. The provider signs nobody in until the domain is verified with verify_sso_domain. Returns the provider view with the DNS record to publish.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: false,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  noBillingGate: true,
  input: z.object({
    providerId: ssoProviderIdSchema,
    displayName: z.string().trim().min(1).max(120),
    domain: ssoDomainSchema,
    groupsClaim: ssoGroupsClaimSchema.optional(),
    config: ssoProtocolInputSchema.superRefine(refineSsoIssuer),
  }),
  output: z.object({ provider: ssoProviderViewSchema }),
});

export type OrgSsoCreateInput = z.output<typeof orgSsoCreate.input>;
export type OrgSsoCreateOutput = z.output<typeof orgSsoCreate.output>;
