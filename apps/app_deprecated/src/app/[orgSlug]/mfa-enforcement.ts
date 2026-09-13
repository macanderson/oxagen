/**
 * MFA enforcement gate — pure decision logic.
 *
 * Security-audit finding: privileged accounts (org Owner/Admin) had no MFA
 * requirement. This evaluator decides whether a request should be allowed
 * through or redirected to TOTP enrollment. It is deliberately pure (no I/O)
 * so the org-layout gate can gather the inputs however it likes and this
 * function stays trivially unit-testable.
 *
 * Policy (scoped to the audit ask — privileged roles only):
 *  - Enforcement is DRIVEN BY the existing, operator-controlled org policy
 *    (security.org_security_policy.mfa_required). Orgs opt in; nothing is
 *    forced on the whole fleet the instant this ships.
 *  - Only Owner/Admin are hard-gated (the privileged set — mirrors
 *    resolve-org's SECURITY_MANAGER_ROLES). Broader member enforcement is out
 *    of scope for this change.
 *  - A grace window (mfa_grace_hours, anchored on when the policy row was last
 *    written) lets a newly-required admin enroll before being blocked, so
 *    turning the policy on does not instantly lock admins out.
 *  - An already-enrolled user is always allowed.
 */

/** Privileged roles subject to the hard gate. Mirrors resolve-org SECURITY_MANAGER_ROLES (lowercased). */
const PRIVILEGED_ROLES = new Set(["owner", "admin"]);

export interface MfaGateInput {
  /** The user's role in the current org (any casing; null when unresolved). */
  role: string | null;
  /** auth.users.two_factor_enabled for this user. */
  twoFactorEnabled: boolean;
  /** The org MFA policy, or null when no policy row exists (defaults: not required). */
  policy: {
    mfaRequired: boolean;
    mfaGraceHours: number;
    updatedAt: Date;
  } | null;
  /** Current time (injected for testability). */
  now: Date;
}

export type MfaGateDecision =
  | { action: "allow" }
  | { action: "redirect-enroll"; reason: "grace-expired" };

/** Decide whether to allow the request or force TOTP enrollment. */
export function evaluateMfaGate(input: MfaGateInput): MfaGateDecision {
  const { role, twoFactorEnabled, policy, now } = input;

  // Already enrolled — nothing to enforce.
  if (twoFactorEnabled) return { action: "allow" };

  // Only privileged roles are gated by this change.
  const normalizedRole = role?.toLowerCase() ?? null;
  if (!normalizedRole || !PRIVILEGED_ROLES.has(normalizedRole)) {
    return { action: "allow" };
  }

  // The org must have opted into MFA enforcement.
  if (!policy || !policy.mfaRequired) return { action: "allow" };

  // Within the grace window (from the policy's last write) — allow for now.
  const graceMs = policy.mfaGraceHours * 60 * 60 * 1000;
  const deadline = policy.updatedAt.getTime() + graceMs;
  if (now.getTime() < deadline) return { action: "allow" };

  return { action: "redirect-enroll", reason: "grace-expired" };
}
