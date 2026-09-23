// Require-SSO gate: pure decision logic, the sibling of mfa-gate.ts (ADR-144).
//
// An organization that set security.org_security_policy.sso_required admits a
// member only through a session one of ITS verified SSO providers established.
// The session records how it was made in auth.sessions.auth_method:
// "sso:<providerId>" for an SSO sign-in, otherwise "password", "social:<p>" or
// "other", and NULL on sessions older than the column. Owners are exempt, so
// an identity-provider outage or a broken provider cannot lock the
// organization out (break-glass). No I/O here, so requireViewer gathers the
// inputs and this stays trivially testable.
import { routes, type SafePath } from "@/shared/safe-path";

/** The session method prefix @oxagen/auth writes for an SSO sign-in. */
const SSO_METHOD_PREFIX = "sso:";

/** Roles the gate never applies to (lowercase). */
const SSO_EXEMPT_ROLES: ReadonlySet<string> = new Set(["owner"]);

/**
 * Where a member without an SSO session is sent, carrying the page they asked
 * for. It lives outside `[org]`, so the redirect cannot loop back through
 * requireViewer.
 */
export function ssoSignInPath(next?: SafePath): SafePath {
  return routes.ssoRequired(next);
}

export type SsoPolicy = {
  ssoRequired: boolean;
  /** The provider ids registered to this organization with a verified domain. */
  providerIds: readonly string[];
};

export type SsoGateInput = {
  /** The member's role in the organization, any casing; null when unresolved. */
  role: string | null;
  /** The organization's policy, or null when it has none (not required). */
  policy: SsoPolicy | null;
  /** auth.sessions.auth_method for the request's session; null when unrecorded. */
  authMethod: string | null;
};

export type SsoGateDecision =
  | { action: "allow" }
  | { action: "sso"; reason: "session_not_sso" };

/** True when the gate could apply, so callers skip reading the session method otherwise. */
export function ssoGateApplies(
  role: string | null,
  policy: SsoPolicy | null,
): boolean {
  return (
    policy?.ssoRequired === true &&
    !(role !== null && SSO_EXEMPT_ROLES.has(role.toLowerCase()))
  );
}

/** The provider id an SSO session names, or null for any other session. */
function sessionProviderId(authMethod: string | null): string | null {
  if (authMethod === null || !authMethod.startsWith(SSO_METHOD_PREFIX)) {
    return null;
  }
  const id = authMethod.slice(SSO_METHOD_PREFIX.length);
  return id === "" ? null : id;
}

export function evaluateSsoGate(input: SsoGateInput): SsoGateDecision {
  const { role, policy, authMethod } = input;
  if (!policy || !ssoGateApplies(role, policy)) return { action: "allow" };
  // Another organization's provider does not count: the session must come
  // from one this organization registered and verified.
  const providerId = sessionProviderId(authMethod);
  if (providerId !== null && policy.providerIds.includes(providerId)) {
    return { action: "allow" };
  }
  return { action: "sso", reason: "session_not_sso" };
}
