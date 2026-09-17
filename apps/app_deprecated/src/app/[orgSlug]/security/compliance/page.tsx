/**
 * Security → Compliance: LIVE-derived SOC 2 control catalog.
 *
 * Control statuses are derived from real signals:
 *   - CC7.2: security_events count (audit pipeline live?)
 *   - CC6.1/CC6.2: org_security_policy.mfa_required
 *   - CC6.1: TENANT_RLS_ENFORCEMENT_ENABLED env flag
 *   - CC6.1: oldest active API key age
 *
 * No more mock data.
 */

import { CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import Link from "next/link";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { and, count, eq, gt, isNull, min, or } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
import { resolveOrg, assertOrgMember } from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
import { getEnterpriseAccess } from "@/lib/enterprise";
import { EnterpriseUpsell } from "@/components/security/enterprise-upsell";
import { org } from "@/lib/routes";
import {
  deriveComplianceControls,
  summariseControls,
  type ControlStatus,
} from "./compliance-controls";

async function loadSignals(orgId: string) {
  const now = new Date();
  const rlsEnforced = process.env["TENANT_RLS_ENFORCEMENT_ENABLED"] === "true";

  // Run all DB queries in parallel via withSystemDb (RLS bypass is fine — this
  // is a security-manager surface that runs inside an org-member gate).
  const [auditRow, policyRow, apiKeyRow] = await Promise.all([
    withSystemDb((tx) =>
      tx
        .select({ c: count() })
        .from(schema.securityEvents)
        .where(eq(schema.securityEvents.orgId, orgId)),
    ),
    withSystemDb((tx) =>
      tx
        .select({
          mfaRequired: schema.orgSecurityPolicy.mfaRequired,
        })
        .from(schema.orgSecurityPolicy)
        .where(eq(schema.orgSecurityPolicy.orgId, orgId))
        .limit(1),
    ),
    withSystemDb((tx) =>
      tx
        .select({ oldest: min(schema.apiKeys.createdAt) })
        .from(schema.apiKeys)
        .where(
          and(
            eq(schema.apiKeys.orgId, orgId),
            isNull(schema.apiKeys.deletedAt),
            or(
              isNull(schema.apiKeys.expiresAt),
              gt(schema.apiKeys.expiresAt, now),
            ),
          ),
        ),
    ),
  ]);

  const auditEventCount = auditRow[0]?.c ?? 0;
  const mfaRequired = policyRow[0]?.mfaRequired ?? false;
  const oldestKeyDate = apiKeyRow[0]?.oldest ?? null;
  const oldestActiveApiKeyDays = oldestKeyDate
    ? Math.floor(
        (now.getTime() - oldestKeyDate.getTime()) / (1000 * 60 * 60 * 24),
      )
    : null;

  return { auditEventCount, mfaRequired, rlsEnforced, oldestActiveApiKeyDays };
}

const STATUS_VARIANT: Record<ControlStatus, "success" | "warning" | "error"> = {
  active: "success",
  partial: "warning",
  not_started: "error",
};

const STATUS_LABEL: Record<ControlStatus, string> = {
  active: "Active",
  partial: "Partial",
  not_started: "Not started",
};

// Semantic tokens, not raw hsl() literals — a palette change in
// packages/ui/src/styles/globals.css must reach this page for free.
const STATUS_ICON_COLOR: Record<ControlStatus, string> = {
  active: "text-success",
  partial: "text-warning",
  not_started: "text-destructive",
};

function ControlStatusIcon({ status }: { status: ControlStatus }) {
  const cls = `mt-0.5 h-4 w-4 shrink-0 ${STATUS_ICON_COLOR[status]}`;
  if (status === "active")
    return <CheckCircle2 className={cls} aria-hidden="true" />;
  if (status === "partial")
    return <AlertTriangle className={cls} aria-hidden="true" />;
  return <XCircle className={cls} aria-hidden="true" />;
}

export default async function SecurityCompliancePage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const [session, tenant] = await Promise.all([
    getSessionOrRedirect(),
    resolveOrg(orgSlug),
  ]);
  await assertOrgMember(tenant.id, session.user.id);

  const [signals, access] = await Promise.all([
    loadSignals(tenant.id),
    getEnterpriseAccess(tenant.id),
  ]);

  const controls = deriveComplianceControls(signals);
  const summary = summariseControls(controls);
  const pct = Math.round((summary.active / summary.total) * 100);
  const ctx = { orgSlug };

  const categories = Array.from(new Set(controls.map((c) => c.category)));

  return (
    <div className="flex flex-col gap-6">
      {!access.isEnterprise && (
        <EnterpriseUpsell
          orgSlug={orgSlug}
          feature="SOC 2 compliance reporting"
          currentTier={access.tier}
        />
      )}

      {/* SOC 2 summary card */}
      <Panel
        title="SOC 2 Type II"
        actions={
          <Badge
            variant={pct >= 80 ? "success" : pct >= 50 ? "warning" : "error"}
            className="shrink-0 text-sm font-semibold px-2.5"
          >
            {pct}% ready
          </Badge>
        }
      >
        <p className="mb-4 text-sm text-muted-foreground">
          Trust Service Criteria control status — derived from live platform
          signals, not static declarations.
        </p>
        <div className="mb-3 h-2 w-full rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span>
            <span className="font-semibold text-success">{summary.active}</span>{" "}
            active
          </span>
          <span>
            <span className="font-semibold text-warning">
              {summary.partial}
            </span>{" "}
            partial
          </span>
          <span>
            <span className="font-semibold text-destructive">
              {summary.notStarted}
            </span>{" "}
            not started
          </span>
        </div>
      </Panel>

      {/* Control catalog */}
      <Panel
        title="Control catalog"
        actions={
          <Button
            variant="outline"
            size="sm"
            render={<Link href={org.security.audit(ctx)} />}
          >
            View audit log
          </Button>
        }
      >
        <p className="mb-4 text-sm text-muted-foreground">
          Trust Service Criteria controls and their current status. Every status
          is derived from live system signals.
        </p>
        {categories.map((category, catIdx) => {
          const catControls = controls.filter((c) => c.category === category);
          return (
            <div key={category}>
              {catIdx > 0 && <Separator className="my-5" />}
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">
                {category}
              </p>
              <div className="flex flex-col gap-2">
                {catControls.map((ctrl) => (
                  <div
                    key={ctrl.id}
                    className="flex flex-col gap-2 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 sm:flex-row sm:items-start sm:gap-4"
                  >
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <ControlStatusIcon status={ctrl.status} />
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs font-semibold text-foreground">
                            {ctrl.criterion}
                          </span>
                          <span className="text-sm font-medium text-foreground">
                            {ctrl.title}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground leading-snug">
                          {ctrl.description}
                        </p>
                        <p className="text-xs text-muted-foreground/70 leading-snug italic mt-0.5">
                          {ctrl.rationale}
                        </p>
                      </div>
                    </div>
                    <Badge
                      variant={STATUS_VARIANT[ctrl.status]}
                      className="shrink-0 self-start text-xs"
                    >
                      {STATUS_LABEL[ctrl.status]}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </Panel>
    </div>
  );
}
