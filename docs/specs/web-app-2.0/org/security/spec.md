---
# Security Posture

- **Route:** `/{orgSlug}/security` (tabs: Overview · MFA · Compliance · Trust)
- **Nav location:** org → Security
- **Priority:** P2
- **Disposition vs today:** Keep (honestly flags unbuilt controls)

## Purpose
Security is the org's posture dashboard — a single place to see authentication health, MFA policy, SOC 2 compliance status, and the org's trust commitments (data residency, encryption, sub-processors, retention). It is deliberately honest about what is and isn't built yet rather than presenting a false all-green state, which is itself part of the trust moat.

## Primary user & jobs-to-be-done
- **Primary user:** Security manager / compliance owner
- **JTBD:**
  - Get a quick read on auth health: recent failures, denied invocations, active API keys.
  - Configure the org's MFA requirement and grace period.
  - See which SOC 2 controls are backed by live evidence versus not yet built.
  - Point a customer or auditor at the org's data-handling commitments.

## Functionality
- **Overview tab:** auth failures (7d), denied invocations count, active API key count, audit-event totals, derived control status table. Two controls explicitly flagged "coming soon": org-wide MFA/SSO enforcement, and the A1.2 backup-restore drill (hard-coded not-on-file).
- **MFA tab:** org MFA policy editor — require-MFA toggle, grace-period setting. Feeds the org-layout MFA redirect gate.
- **Compliance tab:** SOC 2 control catalog rendered from live signals (no mock data).
- **Trust tab:** data residency, encryption-at-rest/in-transit, sub-processor list, retention policy — static content plus live RLS-enforcement badges.

## Capabilities invoked
- Mostly direct DB reads for overview metrics and compliance signals.
- **Contract gap:** org-wide MFA/SSO *enforcement* and the backup-restore drill are genuinely not built — these need contracts and features authored (MFA/SSO enforcement policy write + drill-logging capability), not just UI wiring.

## Data sources
Postgres (`security_events`, API key tables, MFA policy table).

## States
- **Empty:** Overview tiles show zero-state, not blank, when no events in period.
- **Loading:** skeleton tiles/table per tab while metrics resolve independently.
- **Error:** per-tile fallback on metric-fetch failure; MFA policy save failure shows inline toast without losing the current toggle state.

## Existing implementation
- **Today:** `security/page.tsx` is PARTIAL-by-honest-design — live auth failures/denied invocations/API keys/audit totals plus derived control table, with exactly two flagged gaps (MFA/SSO enforcement, backup-restore drill). `security/mfa` is COMPLETE (`assertSecurityManager`, emits `security.mfa_policy_updated`, feeds layout gate). `security/compliance` is COMPLETE ("No more mock data"). `security/trust` is COMPLETE (static-but-accurate plus live RLS badges). Keep as tabs; audit moves to its own route.

## Vision alignment
Trust moat: posture honesty — flagging what isn't built rather than faking it — is itself a differentiator against incumbents that paper over gaps. P2 since core tabs are complete and only two controls await new contracts.
