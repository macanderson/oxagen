import { z } from "zod";

/**
 * Shared wire schemas for enterprise SSO (ADR-142). Not a capability itself:
 * the org.sso.* contracts, the auth package's sign-in provisioner and the app
 * all import from here, so no surface can drift on what a provider, a mapping
 * or a role looks like.
 *
 * An organisation registers an OIDC or SAML identity provider for one email
 * domain, proves it owns the domain with a DNS TXT record, and maps the IdP's
 * groups to organisation roles. Sign-in itself is Better Auth's
 * @better-auth/sso plugin; these capabilities only manage its configuration.
 */

export const ssoProtocolSchema = z.enum(["oidc", "saml"]);
export type SsoProtocolName = z.infer<typeof ssoProtocolSchema>;

/**
 * The roles an IdP group may grant, lowercase.
 *
 * `admin`, `compliance` and `billing` are the organisation IAM roles.
 * `member` is membership with no organisation-wide role, which is what an
 * invitation grants. `owner` is absent on purpose: ownership is transferred by
 * a person, never minted by an identity provider (ADR-142).
 */
export const SSO_MAPPABLE_ROLES = [
  "admin",
  "compliance",
  "billing",
  "member",
] as const;
export const ssoMappableRoleSchema = z.enum(SSO_MAPPABLE_ROLES);
export type SsoMappableRole = z.infer<typeof ssoMappableRoleSchema>;

/**
 * When a person's groups map to more than one role, the highest rank wins.
 * An organisation holds one org role per member (`org_users.role`), so the
 * mapping has to choose, and the most privileged mapped role is the one the
 * admin deliberately granted to someone in that group.
 */
export const SSO_ROLE_RANK: Readonly<Record<SsoMappableRole, number>> = {
  admin: 4,
  compliance: 3,
  billing: 2,
  member: 1,
};

/** The IAM role name for each mappable role; null means no org-wide role. */
export const SSO_IAM_ROLE_NAME: Readonly<
  Record<SsoMappableRole, string | null>
> = {
  admin: "Admin",
  compliance: "Compliance",
  billing: "Billing",
  member: null,
};

export const ssoGroupRoleSchema = z.object({
  /** The group name exactly as the IdP sends it. Case-sensitive. */
  group: z.string().trim().min(1).max(256),
  role: ssoMappableRoleSchema,
});
export type SsoGroupRole = z.infer<typeof ssoGroupRoleSchema>;

/**
 * The role a sign-in grants: the highest-ranked role any of the person's
 * groups maps to, or null when none does. Deny by default: an unmapped group
 * contributes nothing, and no groups at all grants nothing.
 */
export function resolveSsoGrantedRole(
  groups: readonly string[],
  mappings: readonly SsoGroupRole[],
): SsoMappableRole | null {
  const held = new Set(groups);
  let best: SsoMappableRole | null = null;
  for (const m of mappings) {
    if (!held.has(m.group)) continue;
    if (best === null || SSO_ROLE_RANK[m.role] > SSO_ROLE_RANK[best]) {
      best = m.role;
    }
  }
  return best;
}

/**
 * Normalise the groups claim an IdP sends. OIDC providers send an array of
 * strings; SAML attributes arrive as an array or a single string; some IdPs
 * send one comma-separated string. Anything else yields no groups, which
 * grants nothing.
 */
export function normalizeSsoGroups(claim: unknown): string[] {
  const raw = Array.isArray(claim)
    ? claim
    : typeof claim === "string"
      ? claim.split(",")
      : [];
  const out = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) out.add(trimmed);
  }
  return [...out];
}

/**
 * The provider's stable id. It appears in callback URLs, so it is a slug:
 * lowercase letters, digits and hyphens, starting with a letter or digit.
 */
export const ssoProviderIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, {
    message:
      "Use 2 to 63 lowercase letters, digits or hyphens, starting with a letter or digit.",
  });

/** An email domain such as `acme.com`. Stored lowercase. */
export const ssoDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, {
    message: "Enter an email domain such as acme.com.",
  });

/** The claim or attribute that carries groups. Defaults to `groups`. */
export const ssoGroupsClaimSchema = z.string().trim().min(1).max(128);

const httpsUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith("https://"), { message: "Use an https URL." });

/** OIDC settings as an org admin enters them. */
export const ssoOidcInputSchema = z.object({
  protocol: z.literal("oidc"),
  /** The IdP's issuer URL. Its discovery document is read at registration. */
  issuer: httpsUrl,
  clientId: z.string().trim().min(1).max(512),
  clientSecret: z.string().min(1).max(4096),
  /** Extra scopes beyond openid, email and profile. */
  scopes: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
});

/** SAML settings as an org admin enters them. */
export const ssoSamlInputSchema = z.object({
  protocol: z.literal("saml"),
  /** The IdP's entity id. */
  issuer: z.string().trim().min(1).max(1024),
  /** The IdP's single sign-on URL (HTTP-Redirect or HTTP-POST binding). */
  entryPoint: httpsUrl,
  /** The IdP's signing certificate, PEM. Public; stored in the clear. */
  cert: z.string().trim().min(1).max(16384),
  /**
   * Optional SP private key, PEM, for signing AuthnRequests. Sealed with the
   * KMS envelope before it is stored.
   */
  spPrivateKey: z.string().min(1).max(16384).optional(),
});

export const ssoProtocolInputSchema = z.discriminatedUnion("protocol", [
  ssoOidcInputSchema,
  ssoSamlInputSchema,
]);
export type SsoProtocolInput = z.infer<typeof ssoProtocolInputSchema>;

/** The DNS TXT record an org publishes to prove it owns the domain. */
export const ssoDomainVerificationSchema = z.object({
  /** Record name, for example `_oxagen-sso.acme.com`. */
  recordName: z.string(),
  /** Record value, for example `oxagen-sso-verification=…`. */
  recordValue: z.string(),
});

/**
 * A provider as a read returns it. No secret leaves: `clientSecretSet` and
 * `spPrivateKeySet` say whether one is stored, never what it is.
 */
export const ssoProviderViewSchema = z.object({
  providerId: z.string(),
  displayName: z.string(),
  protocol: ssoProtocolSchema,
  domain: z.string(),
  domainVerified: z.boolean(),
  issuer: z.string(),
  groupsClaim: z.string(),
  domainVerification: ssoDomainVerificationSchema,
  /** What the IdP must be configured with: redirect URI or ACS URL. */
  callbackUrl: z.string(),
  /** SAML only: the SP metadata URL the IdP can import. */
  spMetadataUrl: z.string().nullable(),
  oidc: z
    .object({
      clientId: z.string(),
      clientSecretSet: z.boolean(),
      scopes: z.array(z.string()),
    })
    .nullable(),
  saml: z
    .object({
      entryPoint: z.string(),
      spPrivateKeySet: z.boolean(),
    })
    .nullable(),
  groupRoles: z.array(ssoGroupRoleSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SsoProviderView = z.infer<typeof ssoProviderViewSchema>;

export const ssoPolicyViewSchema = z.object({
  /**
   * When true, members other than Owners reach the organisation only through
   * a session one of its SSO providers established, and password sign-in is
   * refused for the providers' email domains.
   */
  ssoRequired: z.boolean(),
});
export type SsoPolicyView = z.infer<typeof ssoPolicyViewSchema>;

/** DNS TXT record name for a domain's verification. */
export function ssoVerificationRecordName(domain: string): string {
  return `_oxagen-sso.${domain}`;
}

/** DNS TXT record value for a verification token. */
export function ssoVerificationRecordValue(token: string): string {
  return `oxagen-sso-verification=${token}`;
}

/** Where the IdP sends people back to, relative to BETTER_AUTH_URL. */
export function ssoCallbackPath(
  protocol: SsoProtocolName,
  providerId: string,
): string {
  return protocol === "oidc"
    ? `/api/auth/sso/callback/${providerId}`
    : `/api/auth/sso/saml2/sp/acs/${providerId}`;
}

/** SAML SP metadata, relative to BETTER_AUTH_URL. */
export function ssoSpMetadataPath(providerId: string): string {
  return `/api/auth/sso/saml2/sp/metadata?providerId=${encodeURIComponent(providerId)}`;
}

/**
 * OIDC settings on an update. The client secret is optional: leaving it out
 * keeps the sealed secret already stored, so an admin who fixes a scope does
 * not have to paste the secret again.
 */
export const ssoOidcUpdateInputSchema = ssoOidcInputSchema.extend({
  clientSecret: ssoOidcInputSchema.shape.clientSecret.optional(),
});

/**
 * SAML settings on an update. Leaving `spPrivateKey` out keeps the sealed key
 * already stored.
 */
export const ssoSamlUpdateInputSchema = ssoSamlInputSchema;

export const ssoProtocolUpdateInputSchema = z.discriminatedUnion("protocol", [
  ssoOidcUpdateInputSchema,
  ssoSamlUpdateInputSchema,
]);
export type SsoProtocolUpdateInput = z.infer<
  typeof ssoProtocolUpdateInputSchema
>;
