// MFA enforcement gate: pure decision logic, ported from
// apps/app_deprecated/src/app/[orgSlug]/mfa-enforcement.ts.
//
// Privileged members (owner, admin) of an organization that set
// security.org_security_policy.mfa_required must enroll TOTP once the grace
// window (mfa_grace_hours from the policy's last write) has passed. Enrolled
// users and non-privileged roles are always allowed. No I/O here, so
// requireViewer gathers the inputs and this stays trivially testable.

/** Roles the hard gate applies to (lowercase). */
export const MFA_PRIVILEGED_ROLES: ReadonlySet<string> = new Set([
  "owner",
  "admin",
]);

/**
 * Where an unenrolled privileged member is sent. It lives outside `[org]`, so
 * the redirect cannot loop back through requireViewer.
 */
export const MFA_ENROLL_PATH = "/two-factor?enroll=required";

export type MfaPolicy = {
  mfaRequired: boolean;
  mfaGraceHours: number;
  updatedAt: Date;
};

export type MfaGateInput = {
  /** The member's role in the organization, any casing; null when unresolved. */
  role: string | null;
  /** auth.users.two_factor_enabled */
  twoFactorEnabled: boolean;
  /** The organization's policy, or null when it has none (not required). */
  policy: MfaPolicy | null;
  now: Date;
};

export type MfaGateDecision =
  | { action: "allow" }
  | { action: "enroll"; reason: "grace_expired" };

/** True when the gate could apply, so callers skip the enrollment read otherwise. */
export function mfaGateApplies(
  role: string | null,
  policy: MfaPolicy | null,
): boolean {
  return (
    policy?.mfaRequired === true &&
    role !== null &&
    MFA_PRIVILEGED_ROLES.has(role.toLowerCase())
  );
}

export function evaluateMfaGate(input: MfaGateInput): MfaGateDecision {
  const { role, twoFactorEnabled, policy, now } = input;
  if (twoFactorEnabled) return { action: "allow" };
  if (!policy || !mfaGateApplies(role, policy)) return { action: "allow" };
  const deadline =
    policy.updatedAt.getTime() + policy.mfaGraceHours * 60 * 60 * 1000;
  if (now.getTime() < deadline) return { action: "allow" };
  return { action: "enroll", reason: "grace_expired" };
}
