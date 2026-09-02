/**
 * metering-kpi-strip.tsx — Overview → top KPI row (the metering wedge).
 *
 * One billing-gated Server Component that fires two reads in parallel and
 * renders four compact KPI cards: month-to-date spend, tokens used, agent runs,
 * and credit balance remaining. Spend/tokens/runs come from
 * billing.usage.breakdown (daily series → sparkline); the remaining balance
 * comes from billing.subscription.read (creditBalanceCents) — the one place a
 * true "remaining" number lives, so we never fabricate a quota.
 *
 * Gating mirrors spend-section.tsx / billing/usage: apps/app does not bootstrap
 * kernel IAM, so billing-manager is asserted explicitly. The gate fails CLOSED
 * — a non-billing member, and a role lookup that errors, both get one
 * "requires billing access" card instead of the row. The two DATA reads fail
 * open (Promise.allSettled), so a dead source dims a card, not the page.
 */
import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import type { BillingUsageBreakdownOutput } from "@oxagen/oxagen/contracts/billing.usage.breakdown";
import type { BillingSubscriptionReadOutput } from "@oxagen/oxagen/contracts/billing.subscription.read";
import Link from "next/link";
import { Wallet, Coins, PlayCircle, PiggyBank } from "lucide-react";
import { Card } from "@/components/ui/card";
import { assertBillingManager } from "@/lib/resolve-org";
import { isAuthDenialError } from "@/lib/auth-denial";
import { org } from "@/lib/routes";
import {
  formatUsdFromMicros,
  formatTokens,
  rangeToWindow,
} from "../../billing/usage/usage-format";
import { StatCard } from "./hud/stat-card";
import { Sparkline } from "./sparkline";

interface Props {
  orgId: string;
  workspaceId: string;
  userId: string;
  orgSlug: string;
  workspaceSlug: string;
}

function invokeCtx(orgId: string, workspaceId: string, userId: string) {
  return {
    orgId,
    workspaceId,
    userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };
}

export async function MeteringKpiStrip({
  orgId,
  workspaceId,
  userId,
  orgSlug,
}: Props) {
  const usageHref = org.billing.usage({ orgSlug });

  // Billing-gate the whole strip. Denial → one compact access card, never a
  // throw. A NON-denial failure (DB outage, timeout) means the role is unknown,
  // so it fails CLOSED to the same card: falling through would render org spend
  // and credit balance to a caller whose billing role was never established —
  // apps/app does not bootstrap kernel IAM, so this gate is the only check.
  try {
    await assertBillingManager(orgId, userId);
  } catch (err) {
    if (!isAuthDenialError(err)) {
      console.error("overview kpi: billing-manager check failed:", err);
    }
    return (
      <Card className="p-4" data-testid="overview-kpi-denied">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground">
              Metering hidden
            </span>
            <span className="text-xs text-muted-foreground">
              Spend, tokens, and balance need billing access — ask an owner,
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
      </Card>
    );
  }

  const ctx = invokeCtx(orgId, workspaceId, userId);
  const { start, end } = rangeToWindow("mtd");

  const [usageRes, subRes] = await runInTenantScope(
    { orgId, workspaceId },
    () =>
      Promise.allSettled([
        invoke(
          "get_usage_breakdown",
          { start: start.toISOString(), end: end.toISOString(), workspaceId },
          ctx,
          { surface: "agent" },
        ) as Promise<BillingUsageBreakdownOutput>,
        invoke("get_subscription", {}, ctx, {
          surface: "agent",
        }) as Promise<BillingSubscriptionReadOutput>,
      ]),
  );

  const usage = usageRes.status === "fulfilled" ? usageRes.value : null;
  const sub = subRes.status === "fulfilled" ? subRes.value : null;

  const costSeries = usage?.series.map((s) => s.costMicros) ?? [];
  const tokenSeries =
    usage?.series.map((s) => s.inputTokens + s.outputTokens) ?? [];
  const runSeries = usage?.series.map((s) => s.executions) ?? [];
  const tokensUsed = usage
    ? usage.totals.inputTokens + usage.totals.outputTokens
    : 0;

  const creditUsd = sub ? sub.creditBalanceCents / 100 : null;
  const planSlug = sub?.subscription?.planSlug ?? null;

  return (
    <div
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
      data-testid="overview-kpi-strip"
    >
      <StatCard
        label="Spend · month to date"
        icon={Wallet}
        value={usage ? formatUsdFromMicros(usage.totals.costMicros) : "—"}
        sub={
          usage
            ? `${usage.totals.executions.toLocaleString()} LLM calls`
            : "Unavailable"
        }
        visual={
          // ≥3 points before drawing a trend: two days of data renders as a
          // single diagonal slash — pure noise that reads as a crash or spike.
          costSeries.length >= 3 ? (
            <Sparkline values={costSeries} aria-label="Daily spend trend" />
          ) : undefined
        }
        href={usageHref}
        data-testid="overview-kpi-spend"
      />
      <StatCard
        label="Tokens used · MTD"
        icon={Coins}
        value={usage ? formatTokens(tokensUsed) : "—"}
        sub={
          usage
            ? `${formatTokens(usage.totals.inputTokens)} in · ${formatTokens(usage.totals.outputTokens)} out`
            : "Unavailable"
        }
        visual={
          tokenSeries.length >= 3 ? (
            <Sparkline values={tokenSeries} aria-label="Daily token trend" />
          ) : undefined
        }
        href={usageHref}
        data-testid="overview-kpi-tokens"
      />
      <StatCard
        label="Agent runs · MTD"
        icon={PlayCircle}
        value={usage ? usage.totals.executions.toLocaleString() : "—"}
        sub={usage ? "metered executions" : "Unavailable"}
        visual={
          runSeries.length >= 3 ? (
            <Sparkline values={runSeries} aria-label="Daily run trend" />
          ) : undefined
        }
        href={usageHref}
        data-testid="overview-kpi-runs"
      />
      <StatCard
        label="Credit balance"
        icon={PiggyBank}
        value={
          creditUsd !== null
            ? creditUsd.toLocaleString(undefined, {
                style: "currency",
                currency: "USD",
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })
            : "—"
        }
        sub={
          planSlug
            ? `${planSlug} plan · remaining`
            : creditUsd !== null
              ? "remaining"
              : "Unavailable"
        }
        href={usageHref}
        data-testid="overview-kpi-credit"
      />
    </div>
  );
}
