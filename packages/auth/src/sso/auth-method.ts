/**
 * How a session was established, recorded on `auth.sessions.auth_method` by
 * the session.create.before hook in auth.ts (ADR-145). Pure, so the sign-in
 * proof test and the hook share it without a database.
 */

/** The session's auth method for an SSO sign-in through `providerId`. */
export function ssoAuthMethod(providerId: string): string {
  return `sso:${providerId}`;
}

/**
 * How a session was established, from the Better Auth endpoint that created
 * it. Recorded once on the session row; the org gate only cares whether it
 * starts with "sso:".
 */
export function authMethodForPath(
  path: string | undefined,
  params: Record<string, unknown> | undefined,
): string {
  if (!path) return "other";
  const providerId =
    typeof params?.providerId === "string" ? params.providerId : null;
  if (
    path.startsWith("/sso/callback/") ||
    path.startsWith("/sso/saml2/callback/") ||
    path.startsWith("/sso/saml2/sp/acs/")
  ) {
    return providerId ? ssoAuthMethod(providerId) : "other";
  }
  if (path.startsWith("/sign-in/email") || path.startsWith("/sign-up/email")) {
    return "password";
  }
  if (path.startsWith("/callback/")) {
    const id = typeof params?.id === "string" ? params.id : path.split("/")[2];
    return id ? `social:${id}` : "other";
  }
  if (path.startsWith("/two-factor/")) return "password";
  return "other";
}
