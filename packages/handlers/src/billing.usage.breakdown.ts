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
import { readUsageBreakdown } from "@oxagen/telemetry";
import { logger } from "./logger";

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
    series: breakdown.series,
    byModel: breakdown.byModel,
    bySurface: breakdown.bySurface,
    byWorkspace: breakdown.byWorkspace,
    byCapability: breakdown.byCapability,
    byPrincipal: breakdown.byPrincipal,
    byUser: breakdown.byUser,
  };
};
