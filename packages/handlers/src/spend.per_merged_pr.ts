// audit-exempt: read-only — joins cost.run_totals to cost.run_pr_outcomes for the period's runs that opened a pull request and folds them per agent; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `get_spend_per_merged_pr` (spend spec, detector 8, its first lever; F26):
// each agent's spend on bounded runs per pull request that landed. One read
// joins the period's run rows to their pull request rows, and
// `spendPerMergedPr` (packages/billing) folds them. A run that opened no pull
// request has only a `none` outcome row, or none yet, so the join leaves it
// out. The period windows runs by start, as `get_spend` does, so an agent's
// figure covers the same runs as its Month row.
import {
  type CostBasis,
  dayBounds,
  NO_PR_KEY,
  type PerMergedPrOutcome,
  type PerMergedPrRun,
  type RunPrState,
  spendPerMergedPr,
} from "@oxagen/billing";
import { schema, withTenantDb } from "@oxagen/database";
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  spendPerMergedPr as spendPerMergedPrContract,
  type SpendPerMergedPrOutput,
} from "@oxagen/oxagen/contracts/spend.per_merged_pr";
import { and, eq, gte, isNotNull, lt, ne } from "drizzle-orm";

export type PerMergedPrScope = { orgId: string; workspaceId: string };
type Window = { start: Date; end: Date };

/** One run and one of its pull requests, as the join returns it. */
export type PerMergedPrRow = PerMergedPrRun & PerMergedPrOutcome;

export type PerMergedPrDeps = {
  /** The period's runs that name an agent, one row per pull request each opened. */
  readRows: (
    scope: PerMergedPrScope,
    window: Window,
  ) => Promise<PerMergedPrRow[]>;
};

async function readRows(
  scope: PerMergedPrScope,
  window: Window,
): Promise<PerMergedPrRow[]> {
  const totals = schema.runTotals;
  const outcomes = schema.runPrOutcomes;
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        runId: totals.runId,
        agentKey: totals.agentKey,
        startedAt: totals.startedAt,
        costMicros: totals.costMicros,
        currency: totals.currency,
        costBasis: totals.costBasis,
        prKey: outcomes.prKey,
        url: outcomes.url,
        prState: outcomes.prState,
        merged: outcomes.merged,
        mergedAt: outcomes.mergedAt,
        reverted: outcomes.reverted,
        revertedAt: outcomes.revertedAt,
      })
      .from(totals)
      .innerJoin(
        outcomes,
        and(
          eq(outcomes.orgId, totals.orgId),
          eq(outcomes.workspaceId, totals.workspaceId),
          eq(outcomes.runId, totals.runId),
        ),
      )
      .where(
        and(
          eq(totals.orgId, scope.orgId),
          eq(totals.workspaceId, scope.workspaceId),
          gte(totals.startedAt, window.start),
          lt(totals.startedAt, window.end),
          isNotNull(totals.agentKey),
          ne(outcomes.prKey, NO_PR_KEY),
        ),
      ),
  );
  // The columns are text; their checks hold them to these values.
  return rows.map((r) => ({
    ...r,
    costBasis: r.costBasis as CostBasis | null,
    prState: r.prState as RunPrState | null,
  }));
}

export function createSpendPerMergedPrHandler(
  deps: PerMergedPrDeps,
): CapabilityHandler<typeof spendPerMergedPrContract> {
  return async (input, ctx): Promise<SpendPerMergedPrOutput> => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const { from, to } = input.period;
    const window = { start: dayBounds(from).start, end: dayBounds(to).next };
    const rows = await deps.readRows(scope, window);
    const agents = spendPerMergedPr(rows, rows);
    const cost = (c: { micros: bigint; currency: string; basis: CostBasis }) => ({
      micros: c.micros.toString(),
      currency: c.currency,
      basis: c.basis,
    });
    return {
      period: { from, to },
      agents: agents.map((a) => ({
        agentKey: a.agentKey,
        boundedRuns: a.boundedRuns,
        unpricedRuns: a.unpricedRuns,
        spend: a.spend === null ? null : cost(a.spend),
        mergedPrs: a.mergedPrs,
        perMergedPr: a.perMergedPr === null ? null : cost(a.perMergedPr),
        absence: a.absence,
        runs: a.runs.map((r) => ({
          runId: r.runId,
          startedAt: r.startedAt.toISOString(),
          cost: r.cost === null ? null : cost(r.cost),
          pullRequests: r.pullRequests,
        })),
      })),
    };
  };
}

export const spendPerMergedPrHandler = createSpendPerMergedPrHandler({
  readRows,
});
