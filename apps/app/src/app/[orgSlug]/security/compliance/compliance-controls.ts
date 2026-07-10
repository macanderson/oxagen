/**
 * compliance-controls.ts — pure helpers for deriving SOC 2 control statuses
 * from live data signals. No DB dependency — callers pass in resolved signals.
 *
 * Extracted here so unit tests can drive the derivation logic without mocking
 * the DB.
 */

export type ControlStatus = "active" | "partial" | "not_started";
export type Framework = "SOC 2 Type II" | "HIPAA" | "GDPR";

export interface ControlSignals {
  /** Total security_events rows for this org (>0 means audit pipeline is live). */
  auditEventCount: number;
  /** MFA required is true in org_security_policy. */
  mfaRequired: boolean;
  /** TENANT_RLS_ENFORCEMENT_ENABLED env flag value. */
  rlsEnforced: boolean;
  /** Age in days of the oldest active API key (null if no active keys). */
  oldestActiveApiKeyDays: number | null;
}

export interface ComplianceControl {
  id: string;
  criterion: string;
  title: string;
  description: string;
  status: ControlStatus;
  rationale: string;
  /** Trust Service Criterion category. */
  category: string;
}

/**
 * Derive live SOC 2 control statuses from the provided signals.
 * All logic is pure — no DB, no I/O.
 */
export function deriveComplianceControls(signals: ControlSignals): ComplianceControl[] {
  const { auditEventCount, mfaRequired, rlsEnforced, oldestActiveApiKeyDays } = signals;

  const auditLive = auditEventCount > 0;
  // CC6.1: Logical access controls. Active when RLS enforced + MFA required.
  // Partial when RLS is enforced but MFA is not yet required.
  const cc61Status: ControlStatus = rlsEnforced && mfaRequired
    ? "active"
    : rlsEnforced
      ? "partial"
      : "not_started";

  const cc61Rationale = rlsEnforced && mfaRequired
    ? "Row-level security enforced org-wide and org-wide MFA is required."
    : rlsEnforced
      ? "Postgres RLS enforced platform-wide. Org-wide MFA enforcement not yet enabled (configure on the MFA tab)."
      : "Row-level security not yet enforced. Configure RLS and MFA enforcement.";

  // CC6.2: Authentication & credential management.
  const cc62Status: ControlStatus = mfaRequired ? "active" : "partial";
  const cc62Rationale = mfaRequired
    ? "Org-wide MFA enforcement is enabled. Members without MFA are blocked after the grace period."
    : "MFA enforcement is not yet required for this org. Enable it on the MFA tab to satisfy CC6.2.";

  // CC6.3: Role-based access and least privilege.
  // Always partial — we have roles (owner/admin/member/billing) but quarterly
  // access reviews are not yet automated.
  const cc63Status: ControlStatus = "partial";
  const cc63Rationale =
    "Role-based access (owner/admin/member/billing) is enforced. Quarterly access reviews are available on the Reviews tab but not yet automated.";

  // CC7.2: Audit trail & monitoring.
  const cc72Status: ControlStatus = auditLive ? "active" : "partial";
  const cc72Rationale = auditLive
    ? `Append-only security_events stream is live (${auditEventCount.toLocaleString()} events) with a consolidated emit path covering all capability invocations, auth events, and org mutations.`
    : "Audit pipeline is wired but no events have been recorded for this org yet.";

  // CC9.2: Vendor and third-party risk management.
  const cc92Status: ControlStatus = "partial";
  const cc92Rationale =
    "Sub-processors (Stripe, Inngest, Vercel, Google Cloud) are documented on the Trust page. Formal vendor risk assessments are in progress.";

  // API key rotation check — heuristic: active keys older than 180 days is a gap.
  const apiKeyStatus: ControlStatus =
    oldestActiveApiKeyDays === null || oldestActiveApiKeyDays <= 180 ? "active" : "partial";
  const apiKeyRationale =
    oldestActiveApiKeyDays === null
      ? "No active API keys."
      : oldestActiveApiKeyDays <= 180
        ? `Oldest active API key is ${oldestActiveApiKeyDays} days old (within the 180-day rotation guideline).`
        : `Oldest active API key is ${oldestActiveApiKeyDays} days old. Rotate keys older than 180 days (CC6.1).`;

  return [
    {
      id: "cc6.1",
      criterion: "CC6.1",
      title: "Logical access controls",
      description:
        "The entity implements logical access security software, infrastructure, and architectures to protect against security events.",
      status: cc61Status,
      rationale: cc61Rationale,
      category: "Logical & Physical Access",
    },
    {
      id: "cc6.2",
      criterion: "CC6.2",
      title: "Authentication and credential management",
      description:
        "Prior to issuing system credentials and granting system access, the entity registers and authorizes new internal and external users whose credentials and system access are associated with their identity.",
      status: cc62Status,
      rationale: cc62Rationale,
      category: "Logical & Physical Access",
    },
    {
      id: "cc6.3",
      criterion: "CC6.3",
      title: "Role-based access and least privilege",
      description:
        "The entity authorizes, modifies, or removes access to data, software, functions, and other protected information assets based on approved changes.",
      status: cc63Status,
      rationale: cc63Rationale,
      category: "Logical & Physical Access",
    },
    {
      id: "cc6.api",
      criterion: "CC6.1",
      title: "API key rotation",
      description:
        "Credentials (API keys) are rotated regularly to limit the impact of a key compromise.",
      status: apiKeyStatus,
      rationale: apiKeyRationale,
      category: "Logical & Physical Access",
    },
    {
      id: "cc7.2",
      criterion: "CC7.2",
      title: "Security event monitoring",
      description:
        "The entity monitors system components and the operation of those components for anomalies that are indicative of malicious acts, natural disasters, and errors affecting the entity's ability to meet its objectives.",
      status: cc72Status,
      rationale: cc72Rationale,
      category: "System Operations",
    },
    {
      id: "cc9.2",
      criterion: "CC9.2",
      title: "Vendor and third-party risk management",
      description:
        "The entity assesses and manages risks associated with vendors and business partners whose products and services, as well as their operating environments, affect the achievement of the entity's objectives.",
      status: cc92Status,
      rationale: cc92Rationale,
      category: "Risk Mitigation",
    },
  ];
}

/**
 * Summarise a set of controls into active/partial/not_started counts.
 */
export function summariseControls(controls: ComplianceControl[]): {
  total: number;
  active: number;
  partial: number;
  notStarted: number;
} {
  return {
    total: controls.length,
    active: controls.filter((c) => c.status === "active").length,
    partial: controls.filter((c) => c.status === "partial").length,
    notStarted: controls.filter((c) => c.status === "not_started").length,
  };
}
