// audit-exempt: read-only usage aggregation (ClickHouse token_usage GROUP BY) — no state mutation; the kernel capability.invoke_* audit covers access.
/**
 * billing.usage.breakdown handler.
 *
 * Aggregates the ClickHouse `token_usage` table into per-model / per-surface /
 * per-workspace breakdowns plus a daily time series, over the requested window,
 * for the caller's org. `input.workspaceId` narrows to a single workspace.
 *
 * The tenant boundary is `ctx.orgId` (from the kernel context), never the input
 * — a caller cannot request another org's usage. `input.workspaceId` only
 * narrows within the already-scoped org.
 *
 * `cacheSavingsMicros` is priced from the price book; see `bookCacheSavings`.
 *
 * ClickHouse errors propagate: a usage read that silently returns zeros on an
 * outage would misreport spend. Callers that need resilience (the dashboard
 * page) wrap the invoke and degrade explicitly.
 */

import type { CapabilityHandler } from "@oxagen/oxagen";
import { billingUsageBreakdown } from "@oxagen/oxagen/contracts/billing.usage.breakdown";
import { readObservedModels, readUsageBreakdown } from "@oxagen/telemetry";
import {
  CACHE_SAVING_TOKEN_CLASSES,
  loadPriceBookInTenantScope,
  netCacheSavingsFromBook,
  priceBookBoundaries,
  type NetCacheSavings,
} from "@oxagen/billing";
import { logger } from "./logger";

/**
 * The window's cache saving NET of the write premium, priced from the price
 * book (#4069, ADR-060): cache reads at input_uncached less their cache_read
 * price, less each cache write's premium over input_uncached, every bucket
 * priced at the entries in force when its calls ran. The arithmetic is
 * `netCacheSavingsFromBook` in @oxagen/billing, the helper the run rollup
 * prices each frame with. The in-code rate card no longer prices this figure;
 * it still prices credit charges, which ADR-060 §1 keeps on it.
 *
 * Population. The class-bucket read here is `readObservedModels` with
 * `frameStores: "gateway"`: it reads `metered_token_usage`, the view
 * `readUsageBreakdown` aggregates, over the same org, workspace and window,
 * so the saving covers the calls the breakdown's `cachedTokens` and
 * `cacheWriteTokens` count and no wrapped-agent call they leave out. Two
 * differences remain. The bucket read skips rows with an empty model id,
 * which no price entry could price anyway. Its upper bound is inclusive, so
 * the window's exclusive `end` is passed as the millisecond before it.
 *
 * A bucket the book cannot price adds nothing and is logged as a count; the
 * contract's figure is a plain integer, so a gap is never priced from a
 * guessed rate.
 */
async function bookCacheSavings(args: {
  orgId: string;
  workspaceId?: string;
  start: Date;
  end: Date;
}): Promise<NetCacheSavings> {
  const book = await loadPriceBookInTenantScope({ orgId: args.orgId });
  const until = new Date(args.end.getTime() - 1);
  const observed = await readObservedModels({
    orgId: args.orgId,
    workspaceId: args.workspaceId,
    since: args.start,
    until,
    frameStores: "gateway",
    boundariesFor: (models) =>
      priceBookBoundaries(book, {
        models,
        tokenClasses: CACHE_SAVING_TOKEN_CLASSES,
        since: args.start,
        until,
      }).map((t) => new Date(t)),
  });
  return netCacheSavingsFromBook({ observed, book, orgId: args.orgId });
}

export const billingUsageBreakdownHandler: CapabilityHandler<
  typeof billingUsageBreakdown
> = async (input, ctx) => {
  const start = new Date(input.start);
  const end = new Date(input.end);

  const [breakdown, savings] = await Promise.all([
    readUsageBreakdown({
      orgId: ctx.orgId,
      workspaceId: input.workspaceId,
      start,
      end,
    }),
    bookCacheSavings({
      orgId: ctx.orgId,
      workspaceId: input.workspaceId,
      start,
      end,
    }),
  ]);

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
      cacheSavingsUnpricedBuckets: savings.unpricedBuckets,
    },
    "billing.usage.breakdown: returned usage breakdown",
  );

  return {
    range: { start: input.start, end: input.end },
    totals: breakdown.totals,
    cacheSavingsMicros: Number(savings.micros),
    series: breakdown.series,
    byModel: breakdown.byModel,
    bySurface: breakdown.bySurface,
    byWorkspace: breakdown.byWorkspace,
    byCapability: breakdown.byCapability,
    byPrincipal: breakdown.byPrincipal,
    byUser: breakdown.byUser,
  };
};
