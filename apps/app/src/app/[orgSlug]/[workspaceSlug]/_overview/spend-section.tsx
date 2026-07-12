/**
 * spend-section.tsx — Overview → Spend tile.
 *
 * Current-period (month-to-date) cost + daily trend from billing.usage.breakdown
 * — the metering→billing wedge surfaced on the workspace home page. Mirrors the
 * gating in apps/app/src/app/[orgSlug]/billing/usage/page.tsx: apps/app does not
 * bootstrap kernel IAM, so the billing-manager role is asserted explicitly here,
 * separately from the page-level assertOrgMember. A non-billing member must
 * never see spend numbers — the tile degrades to a "no access" state instead of
 * throwing, so one non-billing member doesn't take down the whole Overview page
 * (parallel fail-open, same as every other tile).
 */
import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import type { BillingUsageBreakdownOutput } from "@oxagen/oxagen/contracts/billing.usage.breakdown";
import Link from "next/link";
import { Wallet } from "lucide-react";
import { assertBillingManager } from "@/lib/resolve-org";
import { isAuthDenialError } from "@/lib/auth-denial";
import { org, workspace } from "@/lib/routes";
import { Tile, EmptyState, ErrorState } from "../_shared/components";
import { formatUsdFromMicros, rangeToWindow } from "../../billing/usage/usage-format";
import { Sparkline } from "./sparkline";

interface SpendTileProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  orgSlug: string;
  workspaceSlug: string;
}

const EMPTY_BREAKDOWN: BillingUsageBreakdownOutput = {
  range: { start: "", end: "" },
  totals: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costMicros: 0, executions: 0 },
  series: [],
  byModel: [],
  bySurface: [],
  byWorkspace: [],
  byCapability: [],
  byPrincipal: [],
};

export async function SpendTile({
  orgId,
  workspaceId,
  userId,
  orgSlug,
  workspaceSlug,
}: SpendTileProps) {
  const usageHref = org.billing.usage({ orgSlug });
  const askHref = workspace.ask({ orgSlug, workspaceSlug });

  try {
    await assertBillingManager(orgId, userId);
  } catch (err) {
    if (isAuthDenialError(err)) {
      return (
        <div data-testid="overview-spend-tile">
          <Tile title="Spend">
            <EmptyState
              icon={Wallet}
              title="Spend visibility requires billing access"
              description="Ask an org owner, admin, or billing manager for access."
              action={
                <Link href={usageHref} className="text-sm font-medium text-primary hover:underline">
                  View billing →
                </Link>
              }
            />
          </Tile>
        </div>
      );
    }
    // Not an access denial — a real failure resolving the role. Log and fall
    // through to the tile's own try/catch below, which renders the generic
    // ErrorState (never throw from an RSC).
    console.error("overview: billing-manager check failed:", err);
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

  const footer = (
    <Link href={usageHref} className="text-sm font-medium text-primary hover:underline">
      View billing →
    </Link>
  );

  return (
    <div data-testid="overview-spend-tile">
      <Tile title="Spend (month to date)" footer={footer}>
        {failed ? (
          <ErrorState
            title="Spend unavailable"
            description="The usage query failed — spend data is temporarily unavailable."
          />
        ) : breakdown.totals.executions === 0 ? (
          <EmptyState
            icon={Wallet}
            title="No spend yet"
            description="Spend appears here after your first Ask."
            action={
              <Link href={askHref} className="text-sm font-medium text-primary hover:underline">
                Open Ask →
              </Link>
            }
          />
        ) : (
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-2xl font-semibold tabular-nums leading-none text-foreground">
                {formatUsdFromMicros(breakdown.totals.costMicros)}
              </p>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {breakdown.totals.executions.toLocaleString()} LLM calls this period
              </p>
            </div>
            <Sparkline
              values={breakdown.series.map((s) => s.costMicros)}
              className="shrink-0 text-primary"
              aria-label="Daily spend trend"
            />
          </div>
        )}
      </Tile>
    </div>
  );
}
