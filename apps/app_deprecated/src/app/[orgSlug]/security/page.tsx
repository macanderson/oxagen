// Security → Overview: a live control-posture dashboard an enterprise buyer
// can open during their own security review. See
// docs/architecture/security/soc2-simplification.html.
//
// Every figure here is read from live data. Controls that are not yet built
// (SSO enforcement, automated evidence snapshots, automated access review) must
// show as "Not configured" / "Pending", never a faked green. The audit trail is
// live (security_events + the consolidated emit path), so CC7.2 reflects that,
// and org-wide MFA enforcement is read from the policy the MFA tab writes.

import { and, count, desc, eq, gte, isNull, or } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "@oxagen/handlers/logger";
import { resolveOrg } from "@/lib/resolve-org";
import { getEnterpriseAccess } from "@/lib/enterprise";
import { EnterpriseUpsell } from "@/components/security/enterprise-upsell";
import { loadMfaPolicy } from "./mfa/actions";
import { formatDateTime } from "@/lib/utils";
import { org } from "@/lib/routes";
import Link from "next/link";
import {
  ShieldCheck,
  KeyRound,
  AlertTriangle,
  Ban,
  ScrollText,
  CheckCircle2,
  XCircle,
  ClipboardCheck,
  ArrowRight,
} from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Stat, StatGroup } from "@/components/ui/stat";

// Org-only route — sentinel workspaceId (no workspace context).
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface Posture {
  authFailures7d: number;
  deniedInvocations7d: number;
  activeApiKeys: number;
  totalAuditEvents: number;
  lastEventAt: Date | null;
}

const EMPTY_POSTURE: Posture = {
  authFailures7d: 0,
  deniedInvocations7d: 0,
  activeApiKeys: 0,
  totalAuditEvents: 0,
  lastEventAt: null,
};

async function loadPosture(orgId: string): Promise<Posture> {
  const since = new Date(Date.now() - SEVEN_DAYS_MS);
  const now = new Date();
  try {
    return await runInTenantScope({ orgId, workspaceId: ORG_ONLY_WS }, () =>
      withTenantDb(async (tx) => {
        const [failures] = await tx
          .select({ c: count() })
          .from(schema.securityEvents)
          .where(
            and(
              eq(schema.securityEvents.orgId, orgId),
              eq(schema.securityEvents.eventType, "auth.sign_in_failed"),
              gte(schema.securityEvents.occurredAt, since),
            ),
          );

        const [denied] = await tx
          .select({ c: count() })
          .from(schema.securityEvents)
          .where(
            and(
              eq(schema.securityEvents.orgId, orgId),
              eq(schema.securityEvents.eventType, "capability.invoke_denied"),
              gte(schema.securityEvents.occurredAt, since),
            ),
          );

        const [total] = await tx
          .select({ c: count() })
          .from(schema.securityEvents)
          .where(eq(schema.securityEvents.orgId, orgId));

        const [latest] = await tx
          .select({ occurredAt: schema.securityEvents.occurredAt })
          .from(schema.securityEvents)
          .where(eq(schema.securityEvents.orgId, orgId))
          .orderBy(desc(schema.securityEvents.occurredAt))
          .limit(1);

        const [keys] = await tx
          .select({ c: count() })
          .from(schema.apiKeys)
          .where(
            and(
              eq(schema.apiKeys.orgId, orgId),
              isNull(schema.apiKeys.deletedAt),
              or(
                isNull(schema.apiKeys.expiresAt),
                gte(schema.apiKeys.expiresAt, now),
              ),
            ),
          );

        return {
          authFailures7d: failures?.c ?? 0,
          deniedInvocations7d: denied?.c ?? 0,
          activeApiKeys: keys?.c ?? 0,
          totalAuditEvents: total?.c ?? 0,
          lastEventAt: latest?.occurredAt ?? null,
        };
      }),
    );
  } catch (err) {
    // Degrade to zeroes so a DB blip does not 500 the whole security section.
    // This is the one place the page can show a figure that is not live, so it
    // MUST leave a trace: an all-zero posture that nobody logged is
    // indistinguishable from a genuinely clean org.
    logger.error(
      { err, orgId },
      "security-overview: posture query failed; rendering an empty posture",
    );
    return EMPTY_POSTURE;
  }
}

// ---------------------------------------------------------------------------
// SOC 2 control status (derived from live signals)
// ---------------------------------------------------------------------------

type ControlState = "active" | "partial" | "open";

const CONTROL_BADGE: Record<
  ControlState,
  "success-soft" | "warning-soft" | "error-soft"
> = {
  active: "success-soft",
  partial: "warning-soft",
  open: "error-soft",
};
const CONTROL_LABEL: Record<ControlState, string> = {
  active: "Active",
  partial: "Partial",
  open: "Open",
};

function ControlIcon({ state }: { state: ControlState }) {
  if (state === "active")
    return (
      <CheckCircle2
        className="mt-0.5 h-4 w-4 shrink-0 text-success"
        aria-hidden="true"
      />
    );
  if (state === "partial")
    return (
      <AlertTriangle
        className="mt-0.5 h-4 w-4 shrink-0 text-warning"
        aria-hidden="true"
      />
    );
  return (
    <XCircle
      className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
      aria-hidden="true"
    />
  );
}

export default async function SecurityOverviewPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const tenant = await resolveOrg(orgSlug);
  const [posture, access, mfaPolicy] = await Promise.all([
    loadPosture(tenant.id),
    getEnterpriseAccess(tenant.id),
    loadMfaPolicy(tenant.id),
  ]);
  const ctx = { orgSlug };

  const auditLive = posture.totalAuditEvents > 0;
  const mfaRequired = mfaPolicy?.mfaRequired ?? false;

  const controls: Array<{
    criterion: string;
    title: string;
    state: ControlState;
    rationale: string;
  }> = [
    {
      criterion: "CC6.1",
      title: "Logical access controls",
      // RLS + auth rate limiting are platform foundations (always on). Org-wide
      // MFA enforcement is opt-in per org (the MFA tab), so this reaches
      // "active" only once this org has turned it on — the same derivation the
      // Compliance tab uses (deriveComplianceControls).
      state: mfaRequired ? "active" : "partial",
      rationale: mfaRequired
        ? "Postgres RLS and auth rate limiting enforced platform-wide, and org-wide MFA is required for privileged roles. SSO enforcement not yet configurable."
        : "Postgres RLS and auth rate limiting enforced platform-wide. Org-wide MFA enforcement is available but not enabled for this org (configure it on the MFA tab); SSO enforcement not yet configurable.",
    },
    {
      criterion: "CC6.2",
      title: "Access provisioning & periodic review",
      state: "partial",
      rationale:
        "Membership and role changes are audited. A dedicated periodic access-review surface is in progress (admin app).",
    },
    {
      criterion: "CC7.2",
      title: "Audit trail & monitoring",
      state: auditLive ? "active" : "partial",
      rationale: auditLive
        ? `Append-only security_events stream is live (${posture.totalAuditEvents.toLocaleString()} events) with a consolidated emit path.`
        : "Audit pipeline is wired but no events have been recorded for this org yet.",
    },
    {
      criterion: "A1.2",
      title: "Backup restore tested",
      state: "open",
      rationale: "Backup restore drill runbook is not yet on file.",
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      {!access.isEnterprise && (
        <EnterpriseUpsell
          orgSlug={orgSlug}
          feature="SOC 2 compliance tooling"
          currentTier={access.tier}
        />
      )}

      {/* Live posture tiles — shared Stat in a hairline-divided group */}
      <StatGroup columns={3}>
        <Stat
          icon={<AlertTriangle />}
          label="Auth failures (7d)"
          value={posture.authFailures7d.toLocaleString()}
          hint="Failed sign-ins, last 7 days"
          tone={posture.authFailures7d > 0 ? "warning" : "success"}
        />
        <Stat
          icon={<Ban />}
          label="Denied invocations (7d)"
          value={posture.deniedInvocations7d.toLocaleString()}
          hint="Capability authz denials"
          tone={posture.deniedInvocations7d > 0 ? "warning" : "success"}
        />
        <Stat
          icon={<KeyRound />}
          label="Active API keys"
          value={posture.activeApiKeys.toLocaleString()}
          hint="Non-expired, non-revoked"
        />
        <Stat
          icon={<ScrollText />}
          label="Audit events"
          value={posture.totalAuditEvents.toLocaleString()}
          hint={
            posture.lastEventAt
              ? `Last: ${formatDateTime(posture.lastEventAt)}`
              : "No events yet"
          }
        />
        <Stat
          icon={<ShieldCheck />}
          label="MFA enforcement"
          value={mfaRequired ? "Required" : "Not required"}
          hint={
            mfaRequired
              ? `${mfaPolicy?.mfaGraceHours ?? 0}h enrollment grace period`
              : "Enable it on the MFA tab"
          }
          tone={mfaRequired ? "success" : undefined}
        />
        <Stat
          icon={<ShieldCheck />}
          label="SSO enforcement"
          value="—"
          hint="SAML / OIDC coming soon"
        />
      </StatGroup>

      {/* SOC 2 control status */}
      <Panel title="SOC 2 control status">
        <p className="mb-4 text-sm text-muted-foreground">
          Live status for the Trust Service Criteria this workspace touches,
          derived from current platform signals.
        </p>
        <div className="flex flex-col gap-2">
          {controls.map((c) => (
            <div
              key={c.criterion}
              className="flex flex-col gap-2 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 sm:flex-row sm:items-start sm:gap-4"
            >
              <div className="flex flex-1 items-start gap-3 min-w-0">
                <ControlIcon state={c.state} />
                <div className="flex flex-col gap-0.5 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-foreground">
                      {c.criterion}
                    </span>
                    <span className="text-sm font-medium text-foreground">
                      {c.title}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-snug">
                    {c.rationale}
                  </p>
                </div>
              </div>
              <Badge
                variant={CONTROL_BADGE[c.state]}
                className="shrink-0 text-xs"
              >
                {CONTROL_LABEL[c.state]}
              </Badge>
            </div>
          ))}
        </div>
      </Panel>

      {/* Evidence snapshot status + quick links */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Evidence snapshots">
          <p className="mb-4 text-sm text-muted-foreground">
            Automated monthly compliance evidence bundles.
          </p>
          <div className="flex items-center gap-3 rounded-xl border border-dashed border-border/60 bg-muted/20 px-4 py-3">
            <Badge variant="outline" className="shrink-0 text-xs">
              Pending
            </Badge>
            <p className="text-sm text-muted-foreground">
              Automated monthly evidence snapshots are not yet enabled. Once
              live, the most recent bundles will appear here for one-click
              auditor download.
            </p>
          </div>
        </Panel>

        <Panel title="Jump to">
          <p className="mb-4 text-sm text-muted-foreground">
            Drill into the underlying security surfaces.
          </p>
          <div className="flex flex-col gap-2">
            <Link
              href={org.security.audit(ctx)}
              className="flex items-center justify-between rounded-xl border border-border/60 bg-muted/30 px-4 py-3 text-sm text-foreground transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex items-center gap-2">
                <ScrollText
                  className="h-4 w-4 text-muted-foreground"
                  aria-hidden="true"
                />
                Audit log
              </span>
              <ArrowRight
                className="h-4 w-4 text-muted-foreground"
                aria-hidden="true"
              />
            </Link>
            <Link
              href={org.security.compliance(ctx)}
              className="flex items-center justify-between rounded-xl border border-border/60 bg-muted/30 px-4 py-3 text-sm text-foreground transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex items-center gap-2">
                <ClipboardCheck
                  className="h-4 w-4 text-muted-foreground"
                  aria-hidden="true"
                />
                Compliance controls
              </span>
              <ArrowRight
                className="h-4 w-4 text-muted-foreground"
                aria-hidden="true"
              />
            </Link>
          </div>
        </Panel>
      </div>
    </div>
  );
}
