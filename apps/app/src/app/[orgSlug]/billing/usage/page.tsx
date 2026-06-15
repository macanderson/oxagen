/**
 * Billing usage page — live ClickHouse data.
 *
 * Queries the `token_usage` table via sumTokenUsage for the current billing
 * period (30-day rolling window when no active subscription exists).
 * Degrades gracefully: if ClickHouse is unreachable, shows zeros with a note.
 */

import { sumTokenUsage } from "@oxagen/telemetry";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { resolveOrg, assertOrgMember, assertBillingManager } from "@/lib/resolve-org";
import { getSession } from "@/lib/session";
import { and, eq, sql } from "drizzle-orm";
import { formatCents } from "@/lib/utils";
import { Card, CardHeader, CardTitle, CardDescription, CardPanel } from "@/components/ui/card";
import { Panel } from "@/components/ui/panel";
import { logger } from "@oxagen/handlers/logger";

// Sentinel workspaceId for org-only routes. — OXA-1515
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

/** Safely query — return null on ClickHouse failure so UI degrades gracefully. */
async function safeTokenQuery(orgId: string, periodStart: Date, periodEnd: Date) {
  try {
    return await sumTokenUsage({ orgId, periodStart, periodEnd });
  } catch (err) {
    logger.error({ err, orgId }, "billing/usage: sumTokenUsage failed");
    return null;
  }
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl font-bold tabular-nums">{value}</CardTitle>
      </CardHeader>
      {sub ? (
        <CardPanel className="pt-0">
          <p className="text-xs text-muted-foreground">{sub}</p>
        </CardPanel>
      ) : null}
    </Card>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function BillingUsagePage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const [org, session] = await Promise.all([resolveOrg(orgSlug), getSession()]);

  const viewerUserId = session?.user?.id ?? "";
  if (viewerUserId) {
    await assertOrgMember(org.id, viewerUserId);
    // Billing page is gated to owner/admin/billing roles.
    await assertBillingManager(org.id, viewerUserId);
  }

  // Read active subscription period bounds. Fall back to rolling 30-day window.
  const now = new Date();
  let periodStart: Date;
  let periodEnd: Date;
  let hasSub = false;

  try {
    const subRow = await runInTenantScope({ orgId: org.id, workspaceId: ORG_ONLY_WS }, () =>
      withTenantDb((tx) =>
        tx
          .select({
            currentPeriodStart: schema.subscriptions.currentPeriodStart,
            currentPeriodEnd: schema.subscriptions.currentPeriodEnd,
          })
          .from(schema.subscriptions)
          .where(
            and(
              eq(schema.subscriptions.orgId, org.id),
              sql`${schema.subscriptions.status} IN ('active','trialing')`,
            ),
          )
          .limit(1),
      ),
    );
    if (subRow[0]?.currentPeriodStart && subRow[0]?.currentPeriodEnd) {
      periodStart = subRow[0].currentPeriodStart;
      periodEnd = subRow[0].currentPeriodEnd;
      hasSub = true;
    } else {
      periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
      periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    }
  } catch {
    periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  }

  const rollup = await safeTokenQuery(org.id, periodStart, periodEnd);
  const queryFailed = rollup === null;

  const inputTokens = rollup?.find((r) => r.metric === "tokens_input")?.quantity ?? 0;
  const outputTokens = rollup?.find((r) => r.metric === "tokens_output")?.quantity ?? 0;
  const cachedTokens = rollup?.find((r) => r.metric === "tokens_cached")?.quantity ?? 0;
  const executions = rollup?.find((r) => r.metric === "executions")?.quantity ?? 0;
  const totalCostMicros = rollup?.find((r) => r.metric === "executions")?.costMicros ?? 0n;

  const totalTokens = inputTokens + outputTokens;
  // costMicros → cents: 1 cent = 10_000 micros (1 USD = 100 cents = 1_000_000 micros)
  const costCents = Number(totalCostMicros) / 10_000;

  const periodLabel = `${periodStart.toLocaleDateString("en-US", { month: "long", day: "numeric" })} – ${periodEnd.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;

  return (
    <div className="flex flex-col gap-6">
      {/* Period header */}
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">
          {hasSub ? "Current billing period" : "Current month (calendar)"}
        </p>
        <p className="text-sm text-foreground font-medium">{periodLabel}</p>
        {queryFailed ? (
          <p className="text-xs text-destructive mt-1">
            Usage data is temporarily unavailable — ClickHouse query failed. Showing zeros.
          </p>
        ) : null}
      </div>

      {/* KPI row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Credits spent"
          value={formatCents(Math.round(costCents))}
          sub="this billing period"
        />
        <StatCard
          label="Total tokens"
          value={totalTokens >= 1_000_000 ? `${(totalTokens / 1_000_000).toFixed(1)}M` : totalTokens.toLocaleString()}
          sub={`${inputTokens.toLocaleString()} in · ${outputTokens.toLocaleString()} out`}
        />
        <StatCard
          label="Cached tokens"
          value={cachedTokens >= 1_000_000 ? `${(cachedTokens / 1_000_000).toFixed(1)}M` : cachedTokens.toLocaleString()}
          sub="prompt cache hits"
        />
        <StatCard
          label="LLM calls"
          value={executions.toLocaleString()}
          sub="token_usage rows this period"
        />
      </div>

      {/* Token breakdown */}
      <Panel title="Token usage">
        <p className="mb-4 text-sm text-muted-foreground">Input / output / cached tokens this period</p>
          {totalTokens === 0 ? (
            <p className="text-sm text-muted-foreground">
              {queryFailed
                ? "Data unavailable."
                : "No token usage recorded for this period yet."}
            </p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Input</span>
                  <span className="text-xl font-bold tabular-nums">
                    {inputTokens >= 1_000_000
                      ? `${(inputTokens / 1_000_000).toFixed(1)}M`
                      : inputTokens.toLocaleString()}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Output</span>
                  <span className="text-xl font-bold tabular-nums">
                    {outputTokens >= 1_000_000
                      ? `${(outputTokens / 1_000_000).toFixed(1)}M`
                      : outputTokens.toLocaleString()}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Cached</span>
                  <span className="text-xl font-bold tabular-nums">
                    {cachedTokens >= 1_000_000
                      ? `${(cachedTokens / 1_000_000).toFixed(1)}M`
                      : cachedTokens.toLocaleString()}
                  </span>
                </div>
              </div>

              {totalTokens > 0 ? (
                <>
                  {/* Input vs output stacked bar */}
                  <div className="mt-4 h-2 w-full rounded-full bg-muted overflow-hidden flex">
                    <div
                      className="h-full bg-primary/70"
                      style={{ width: `${Math.round((inputTokens / totalTokens) * 100)}%` }}
                    />
                    <div className="h-full bg-primary flex-1" />
                  </div>
                  <div className="mt-1 flex gap-4 text-[10px] text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary/70" />
                      Input {Math.round((inputTokens / totalTokens) * 100)}%
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
                      Output {Math.round((outputTokens / totalTokens) * 100)}%
                    </span>
                  </div>
                </>
              ) : null}
            </>
          )}
      </Panel>

      {/* Cost summary */}
      <Panel title="Cost summary">
        <p className="mb-4 text-sm text-muted-foreground">
          Total cost this period (1 credit = $0.01).{" "}
          {!hasSub ? "No active subscription — showing calendar month." : ""}
        </p>
          <div className="grid grid-cols-2 gap-6 text-sm sm:grid-cols-3">
            <div>
              <p className="text-muted-foreground text-xs mb-1">Credits spent</p>
              <p className="text-xl font-bold tabular-nums">{formatCents(Math.round(costCents))}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs mb-1">LLM calls</p>
              <p className="text-xl font-bold tabular-nums">{executions.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs mb-1">Tokens (total)</p>
              <p className="text-xl font-bold tabular-nums">
                {totalTokens >= 1_000_000
                  ? `${(totalTokens / 1_000_000).toFixed(1)}M`
                  : totalTokens.toLocaleString()}
              </p>
            </div>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Per-model and per-capability breakdowns will be available once the usage analytics
            pipeline lands in the agent epic (OXA-1585).
          </p>
      </Panel>
    </div>
  );
}
