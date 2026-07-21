// audit-exempt: read-only usage aggregation (ClickHouse token_usage GROUP BY) — no state mutation; the kernel capability.invoke_* audit covers access.
/**
 * billing.usage.breakdown handler — OXA-1585
 *
 * Aggregates the ClickHouse `token_usage` table into per-model / per-surface /
 * per-workspace breakdowns plus a daily time series, over the requested window,
 * for the caller's org. `input.workspaceId` narrows to a single workspace.
 *
 * The tenant boundary is `ctx.orgId` (from the kernel context), never the input
 * — a caller cannot request another org's usage. `input.workspaceId` only
 * narrows within the already-scoped org.
 *
 * ClickHouse errors propagate: a usage read that silently returns zeros on an
 * outage would misreport spend. Callers that need resilience (the dashboard
 * page) wrap the invoke and degrade explicitly.
 */

import type { CapabilityHandler } from "@oxagen/oxagen";
import { billingUsageBreakdown } from "@oxagen/oxagen/contracts/billing.usage.breakdown";
import { readUsageBreakdown, type UsageBreakdownRow } from "@oxagen/telemetry";
import { resolveRate } from "@oxagen/billing";
import { logger } from "./logger";

/**
 * Estimate cache savings (micro-USD) NET of the write premium, using the
 * per-model provider rate card. For each model row:
 *   reads saved  = cachedTokens × (inputPer1M − cachedInputPer1M)
 *   writes cost  = cacheWriteTokens × (cacheWritePer1M − inputPer1M)
 * savings = Σ (reads saved − writes cost). Rate keys are per 1M tokens, so
 * divide by 1M and scale to micro-USD (×1M) — the two cancel, leaving the rate
 * delta × token count as micro-USD directly. Reads dominate for cache-friendly
 * workloads; the figure can go slightly negative when writes outweigh reads.
 */
function estimateCacheSavingsMicros(byModel: UsageBreakdownRow[]): number {
  let micros = 0;
  for (const row of byModel) {
    const rate = resolveRate(row.key);
    const readsSaved =
      row.cachedTokens * (rate.inputPer1M - rate.cachedInputPer1M);
    const writesCost =
      row.cacheWriteTokens * (rate.cacheWritePer1M - rate.inputPer1M);
    micros += readsSaved - writesCost;
  }
  return Math.round(micros);
}

export const billingUsageBreakdownHandler: CapabilityHandler<
  typeof billingUsageBreakdown
> = async (input, ctx) => {
  const start = new Date(input.start);
  const end = new Date(input.end);

  const breakdown = await readUsageBreakdown({
    orgId: ctx.orgId,
    workspaceId: input.workspaceId,
    start,
    end,
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: input.workspaceId ?? null,
      surface: ctx.surface,
      start: input.start,
      end: input.end,
      models: breakdown.byModel.length,
      surfaces: breakdown.bySurface.length,
      workspaces: breakdown.byWorkspace.length,
      capabilities: breakdown.byCapability.length,
      principals: breakdown.byPrincipal.length,
      users: breakdown.byUser.length,
      executions: breakdown.totals.executions,
      messages: breakdown.totals.messages,
    },
    "billing.usage.breakdown: returned usage breakdown",
  );

  return {
    range: { start: input.start, end: input.end },
    totals: breakdown.totals,
    cacheSavingsMicros: estimateCacheSavingsMicros(breakdown.byModel),
    series: breakdown.series,
    byModel: breakdown.byModel,
    bySurface: breakdown.bySurface,
    byWorkspace: breakdown.byWorkspace,
    byCapability: breakdown.byCapability,
    byPrincipal: breakdown.byPrincipal,
    byUser: breakdown.byUser,
  };
};
