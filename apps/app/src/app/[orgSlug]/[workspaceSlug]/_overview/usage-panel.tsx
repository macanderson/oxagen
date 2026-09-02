/**
 * usage-panel.tsx — Overview HUD → Usage data panel (billing-gated).
 *
 * Mirrors the gating in spend-section.tsx / metering-kpi-strip.tsx: apps/app
 * does not bootstrap kernel IAM, so billing-manager is asserted explicitly.
 * The gate fails CLOSED (a member without the role, and an unresolvable role,
 * both get the "requires billing access" card); the DATA read below it fails
 * open into an error state, so a dead ClickHouse dims this one tile rather
 * than taking down the Overview page.
 *
 * Fetches month-to-date usage via billing.usage.breakdown and renders the
 * shared reaviz charts (daily tokens + top models by cost) through the
 * client-only usage-panel-charts.tsx wrapper.
 */
import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import type { BillingUsageBreakdownOutput } from "@oxagen/oxagen/contracts/billing.usage.breakdown";
import Link from "next/link";
import { Gauge } from "lucide-react";
import { Card, CardHeader, CardTitle, CardPanel } from "@/components/ui/card";
import { assertBillingManager } from "@/lib/resolve-org";
import { isAuthDenialError } from "@/lib/auth-denial";
import { org } from "@/lib/routes";
import { EmptyState, ErrorState } from "../_shared/components";
import {
  formatUsdFromMicros,
  rangeToWindow,
} from "../../billing/usage/usage-format";
import { UsagePanelCharts } from "./usage-panel-charts";

interface UsagePanelProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  orgSlug: string;
  workspaceSlug: string;
}

const EMPTY_BREAKDOWN: BillingUsageBreakdownOutput = {
  range: { start: "", end: "" },
  totals: {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    costMicros: 0,
    executions: 0,
    messages: 0,
  },
  cacheSavingsMicros: 0,
  series: [],
  byModel: [],
  bySurface: [],
  byWorkspace: [],
  byCapability: [],
  byPrincipal: [],
  byUser: [],
};

export async function UsagePanel({
  orgId,
  workspaceId,
  userId,
  orgSlug,
}: UsagePanelProps) {
  const usageHref = org.billing.usage({ orgSlug });

  // Fails CLOSED on a non-denial error too: an unknown role is not an
  // authorized one, and falling through would render the org's usage breakdown
  // to a caller whose billing role was never established.
  try {
    await assertBillingManager(orgId, userId);
  } catch (err) {
    if (!isAuthDenialError(err)) {
      console.error("overview usage panel: billing-manager check failed:", err);
    }
    return (
      <Card data-testid="overview-usage-panel">
        <CardPanel className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">
                Usage hidden
              </span>
              <span className="text-xs text-muted-foreground">
                Usage breakdown requires billing access — ask an org owner,
                admin, or billing manager.
              </span>
            </div>
            <Link
              href={usageHref}
              className="text-sm font-medium text-primary hover:underline"
            >
              View billing →
            </Link>
          </div>
        </CardPanel>
      </Card>
    );
  }

  let breakdown = EMPTY_BREAKDOWN;
  let failed = false;
  try {
    const { start, end } = rangeToWindow("mtd");
    breakdown = (await runInTenantScope({ orgId, workspaceId }, () =>
      invoke(
        "get_usage_breakdown",
        { start: start.toISOString(), end: end.toISOString(), workspaceId },
        {
          orgId,
          workspaceId,
          userId,
          apiKeyId: null as string | null,
          requestId: crypto.randomUUID(),
          surface: "app" as const,
          messageId: null as string | null,
        },
        { surface: "agent" },
      ),
    )) as BillingUsageBreakdownOutput;
  } catch (e) {
    console.error("get_usage_breakdown failed:", e);
    failed = true;
  }

  return (
    <div data-testid="overview-usage-panel">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base">Usage</CardTitle>
          <Link
            href={usageHref}
            className="text-sm font-medium text-primary hover:underline"
          >
            Full breakdown →
          </Link>
        </CardHeader>
        <CardPanel className="pt-4">
          {failed ? (
            <ErrorState
              title="Usage unavailable"
              description="The usage query failed — usage data is temporarily unavailable."
            />
          ) : breakdown.totals.executions === 0 ? (
            <EmptyState
              icon={Gauge}
              title="No usage yet"
              description="Usage appears here after your first Ask."
              action={
                <Link
                  href={usageHref}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  View billing →
                </Link>
              }
            />
          ) : (
            <div className="flex flex-col gap-4">
              <div>
                <p className="text-2xl font-semibold tabular-nums leading-none text-foreground">
                  {formatUsdFromMicros(breakdown.totals.costMicros)}
                </p>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {breakdown.totals.executions.toLocaleString()} LLM calls ·
                  month to date
                </p>
              </div>
              <UsagePanelCharts
                series={breakdown.series}
                byModel={breakdown.byModel}
              />
            </div>
          )}
        </CardPanel>
      </Card>
    </div>
  );
}
