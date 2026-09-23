/**
 * "Require SSO" at sign-in, and the session's auth method (ADR-144).
 *
 * An organisation that turns on security.org_security_policy.sso_required
 * wants its people to arrive through its identity provider. Two places hold
 * that line:
 *   - here, at sign-in: a password or social sign-in whose email domain
 *     belongs to such an organisation's verified provider is refused;
 *   - the app's org gate, which reads `sessions.auth_method` and sends a
 *     non-SSO session back to /login?sso=required.
 *
 * Owners are exempt in both places. They are the break-glass account: an IdP
 * outage or a broken provider config must not lock the organisation out of
 * the page where it would be fixed.
 */
import { and, eq, inArray } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";

export { authMethodForPath, ssoAuthMethod } from "./auth-method";
import { emailDomain } from "./email-domain";
import { orgHasSso } from "./entitlement";
export { emailDomain };

/** The APIError body code the login form maps to its SSO message. */
export const SSO_REQUIRED_CODE = "SSO_REQUIRED";

export const SSO_REQUIRED_MESSAGE =
  "Your organization requires single sign-on. Sign in with SSO.";

/**
 * The domain and each parent that still has a dot in it: `eng.acme.com` gives
 * `eng.acme.com` and `acme.com`, never the bare `com`.
 */
export function candidateDomains(domain: string): string[] {
  const labels = domain.split(".");
  const out: string[] = [];
  for (let i = 0; i < labels.length - 1; i++) {
    out.push(labels.slice(i).join("."));
  }
  return out;
}

/**
 * Whether signing in as `email` any way other than SSO is refused: the
 * domain has a verified provider whose organisation requires SSO, and the
 * person is not an Owner of that organisation.
 *
 * tenancy: system bypass via withSystemDb (sign-in runs before a session or
 * tenant scope exists; the lookup is keyed by the email domain the person
 * typed and returns only a yes/no).
 */
export async function isNonSsoSignInRefused(email: string): Promise<boolean> {
  const domain = emailDomain(email);
  if (!domain) return false;

  // tenancy: system bypass during sign-in bootstrap, before any session exists; the lookup is filtered by the email domain and the verified provider's orgId.
  const orgs = await withSystemDb((tx) =>
    tx
      .select({ orgId: schema.ssoProviderTable.organizationId })
      .from(schema.ssoProviderTable)
      .innerJoin(
        schema.orgSecurityPolicy,
        eq(
          schema.orgSecurityPolicy.orgId,
          schema.ssoProviderTable.organizationId,
        ),
      )
      .where(
        and(
          // The domain or any parent of it: sign-in routes a subdomain to its
          // parent's provider, so the refusal has to cover it too.
          inArray(schema.ssoProviderTable.domain, candidateDomains(domain)),
          eq(schema.ssoProviderTable.domainVerified, true),
          eq(schema.orgSecurityPolicy.ssoRequired, true),
        ),
      )
      .limit(1),
  );
  const orgId = orgs[0]?.orgId;
  if (!orgId) return false;
  // Require SSO applies only while the plan includes SSO. After a downgrade
  // SSO sign-in is refused, so enforcing this too would lock everyone out.
  if (!(await orgHasSso(orgId))) return false;

  // tenancy: system bypass during sign-in bootstrap, before any session exists; the lookup is filtered by the email domain and the verified provider's orgId.
  const owners = await withSystemDb((tx) =>
    tx
      .select({ role: schema.orgUsers.role })
      .from(schema.orgUsers)
      .innerJoin(schema.users, eq(schema.users.id, schema.orgUsers.userId))
      .where(
        and(
          eq(schema.orgUsers.orgId, orgId),
          eq(schema.users.email, email.trim().toLowerCase()),
          inArray(schema.orgUsers.role, ["owner", "Owner"]),
        ),
      )
      .limit(1),
  );
  return owners.length === 0;
}

/**
 * An SSO provider's domain and whether it is verified, or null when
 * `providerId` names no SSO provider (a social provider, the credential
 * account). The domain guard's lookup (./domain-guard.ts).
 */
export async function lookupSsoProviderDomain(
  providerId: string,
): Promise<{ domain: string; domainVerified: boolean } | null> {
  // tenancy: system bypass during sign-in bootstrap, before any session exists; the lookup is filtered by the provider id the callback route names and returns only its domain and verified flag.
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        domain: schema.ssoProviderTable.domain,
        domainVerified: schema.ssoProviderTable.domainVerified,
      })
      .from(schema.ssoProviderTable)
      .where(eq(schema.ssoProviderTable.providerId, providerId))
      .limit(1),
  );
  return rows[0] ?? null;
}
