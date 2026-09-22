/**
 * "Require SSO" at sign-in, and the session's auth method (ADR-142).
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

/** The APIError body code the login form maps to its SSO message. */
export const SSO_REQUIRED_CODE = "SSO_REQUIRED";

export const SSO_REQUIRED_MESSAGE =
  "Your organization requires single sign-on. Sign in with SSO.";

/** The email's domain, lowercased, or null for a malformed address. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase();
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
          eq(schema.ssoProviderTable.domain, domain),
          eq(schema.ssoProviderTable.domainVerified, true),
          eq(schema.orgSecurityPolicy.ssoRequired, true),
        ),
      )
      .limit(1),
  );
  const orgId = orgs[0]?.orgId;
  if (!orgId) return false;

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
