/**
 * Billing usage dashboard — metering → billing visibility (the wedge).
 *
 * Reads the billing.usage.breakdown capability (grouped ClickHouse token_usage
 * aggregates) for the selected preset window and renders totals, daily trend
 * charts, and per-model / per-surface / per-workspace breakdown tables.
 *
 * Data flows through invoke() so the read is observed like every capability.
 * apps/app does not bootstrap kernel IAM, so the caller is gated explicitly here
 * (assertOrgMember + assertBillingManager) before the invoke.
 */

import { invoke } from "@oxagen/oxagen";
// Side-effect import binds every handler into the kernel — without it invoke()
// throws "No handler registered". Mirrors the other app-side invoke call sites.
import "@oxagen/handlers/register";
import type { BillingUsageBreakdownOutput } from "@oxagen/oxagen/contracts/billing.usage.breakdown";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq } from "drizzle-orm";
import {
  resolveOrg,
  assertOrgMember,
  assertBillingManager,
} from "@/lib/resolve-org";
import { getSession } from "@/lib/session";
import { Stat, StatGroup } from "@/components/ui/stat";
import { logger } from "@oxagen/handlers/logger";
import { UsageBreakdownView } from "./usage-breakdown-view";
import { UsageRangePicker } from "./usage-range-picker";
import {
  parseRange,
  rangeToWindow,
  rangeLabel,
  formatTokens,
  formatUsdFromMicros,
} from "./usage-format";

// Sentinel workspaceId for org-only routes.
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

const EMPTY: BillingUsageBreakdownOutput = {
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

export default async function BillingUsagePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const [{ orgSlug }, sp] = await Promise.all([params, searchParams]);
  const [org, session] = await Promise.all([resolveOrg(orgSlug), getSession()]);

  const viewerUserId = session?.user?.id ?? "";
  if (viewerUserId) {
    await assertOrgMember(org.id, viewerUserId);
    // Billing surface is gated to owner/admin/billing roles.
    await assertBillingManager(org.id, viewerUserId);
  }

  const rangeKey = parseRange(sp.range);
  const { start, end } = rangeToWindow(rangeKey);
  const basePath = `/${orgSlug}/billing/usage`;

  // Fetch the breakdown + workspace name map inside one tenant scope. The invoke
  // is wrapped so a ClickHouse outage degrades to zeros rather than a 500 — the
  // capability itself throws; the dashboard chooses to stay resilient.
  const workspaceNames: Record<string, string> = {};

  const { breakdown, queryFailed } = await runInTenantScope(
    { orgId: org.id, workspaceId: ORG_ONLY_WS },
    async () => {
      try {
        const wsRows = await withTenantDb((tx) =>
          tx
            .select({ id: schema.workspaces.id, name: schema.workspaces.name })
            .from(schema.workspaces)
            .where(eq(schema.workspaces.orgId, org.id)),
        );
        for (const w of wsRows) workspaceNames[w.id] = w.name;
      } catch (err) {
        logger.warn(
          { err, orgId: org.id },
          "billing/usage: workspace name resolve failed",
        );
      }

      try {
        const ctx = {
          orgId: org.id,
          workspaceId: ORG_ONLY_WS,
          userId: viewerUserId,
          apiKeyId: null as string | null,
          requestId: crypto.randomUUID(),
          surface: "app" as const,
          messageId: null as string | null,
        };
        const result = (await invoke(
          "get_usage_breakdown",
          { start: start.toISOString(), end: end.toISOString() },
          ctx,
          { surface: "agent" },
        )) as BillingUsageBreakdownOutput;
        return { breakdown: result, queryFailed: false };
      } catch (err) {
        logger.error(
          { err, orgId: org.id },
          "billing/usage: breakdown invoke failed",
        );
        return { breakdown: EMPTY, queryFailed: true };
      }
    },
  );

  const { totals } = breakdown;
  const totalTokens = totals.inputTokens + totals.outputTokens;
  // Cache hit rate: share of input tokens served from the prompt cache (reads).
  // inputTokens is the inclusive total (fresh + reads + writes), so this reads as
  // "% of input we didn't pay full rate for". Guard the empty window (0/0).
  const cacheHitPct =
    totals.inputTokens > 0 ? totals.cachedTokens / totals.inputTokens : 0;
  const cacheSavings = formatUsdFromMicros(breakdown.cacheSavingsMicros);

  return (
    <div className="flex flex-col gap-6">
      {/* Range header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Usage window
          </p>
          <p className="text-sm font-medium text-foreground">
            Last {rangeLabel(rangeKey).toLowerCase()}
          </p>
        </div>
        <UsageRangePicker basePath={basePath} active={rangeKey} />
      </div>

      {queryFailed ? (
        <p className="text-xs text-destructive">
          Usage data is temporarily unavailable — the analytics query failed.
          Showing zeros.
        </p>
      ) : null}

      {/* KPI row — shared Stat tiles in a hairline-divided group */}
      <StatGroup columns={4}>
        <Stat
          label="Total cost"
          value={formatUsdFromMicros(totals.costMicros)}
          hint="LLM spend this window"
        />
        <Stat
          label="Total tokens"
          value={formatTokens(totalTokens)}
          hint={`${totals.inputTokens.toLocaleString()} in · ${totals.outputTokens.toLocaleString()} out`}
        />
        <Stat
          label="Cached tokens"
          value={formatTokens(totals.cachedTokens)}
          hint="prompt cache hits"
        />
        <Stat
          label="LLM calls"
          value={totals.executions.toLocaleString()}
          hint="metered token_usage rows"
        />
      </StatGroup>

      {/* Cache economics — the discount a cache-friendly agent earns. */}
      <StatGroup columns={4}>
        <Stat
          label="Cache hit rate"
          value={`${(cacheHitPct * 100).toFixed(1)}%`}
          hint="of input tokens served from cache"
        />
        <Stat
          label="Cache reads"
          value={formatTokens(totals.cachedTokens)}
          hint="billed at the cheaper cached rate"
        />
        <Stat
          label="Cache writes"
          value={formatTokens(totals.cacheWriteTokens)}
          hint="cache creation, billed at a premium"
        />
        <Stat
          label="Cache savings"
          value={cacheSavings}
          intent={breakdown.cacheSavingsMicros >= 0 ? "positive" : "neutral"}
          hint="net of the write premium, this window"
        />
      </StatGroup>

      <UsageBreakdownView
        series={breakdown.series}
        byModel={breakdown.byModel}
        bySurface={breakdown.bySurface}
        byWorkspace={breakdown.byWorkspace}
        workspaceNames={workspaceNames}
      />
    </div>
  );
}
