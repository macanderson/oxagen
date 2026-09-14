// audit-exempt: read-only — answers wasted spend by cause from cost.run_totals; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `list_waste` (ADR-058): each cause is a pattern read off the run rows with
// the money the frames put on it. The one cause the rollup can cost exactly
// today is a cache written and never read (spec §12.8 "Cache writes never
// read"): the run wrote prompt-cache tokens and read none, so every cache
// write premium it paid bought nothing. The findings job that costs the other
// patterns is the findings lane; its causes join this list.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  spendWasteList,
  type SpendWasteListOutput,
} from "@oxagen/oxagen/contracts/spend.waste";
import type { CostBasis, RunTotalsRecord } from "@oxagen/billing";
import {
  cost,
  foldBases,
  readRunTotals,
  type RunFilter,
  type SpendScope,
} from "./spend.shared";

export type SpendWasteDeps = {
  readRunTotals: (
    scope: SpendScope,
    q: { from: string; to: string; filter: RunFilter },
  ) => Promise<RunTotalsRecord[]>;
};

const CITED_RUNS = 10;

/** The cache-write cost of a run that read nothing back, or null when the pattern is absent. */
export function cacheWriteNeverRead(
  run: RunTotalsRecord,
): { micros: bigint; basis: CostBasis } | null {
  const wrote = run.tokens.cache_write_5m + run.tokens.cache_write_1h;
  if (wrote === 0 || run.tokens.cache_read > 0 || run.costBasis === null)
    return null;
  let micros = 0n;
  for (const m of run.breakdown.models)
    micros += m.costByClass.cache_write_5m + m.costByClass.cache_write_1h;
  return { micros, basis: run.costBasis };
}

export function createSpendWasteHandler(
  deps: SpendWasteDeps,
): CapabilityHandler<typeof spendWasteList> {
  return async (input, ctx): Promise<SpendWasteListOutput> => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const { from, to } = input.period;
    const runs = await deps.readRunTotals(scope, {
      from,
      to,
      filter: { kind: "all" },
    });
    const currency = runs[0]?.currency ?? "USD";

    const hits = runs
      .flatMap((run) => {
        const waste = cacheWriteNeverRead(run);
        return waste ? [{ runId: run.runId, ...waste }] : [];
      })
      .sort((a, b) => (a.micros > b.micros ? -1 : a.micros < b.micros ? 1 : 0));

    const wastedMicros = hits.reduce((sum, h) => sum + h.micros, 0n);
    const basis = foldBases(hits.map((h) => h.basis));
    const wasted =
      hits.length === 0 ? null : cost(wastedMicros, currency, basis);

    let pricedMicros: bigint | null = null;
    for (const run of runs)
      if (run.costMicros !== null)
        pricedMicros = (pricedMicros ?? 0n) + run.costMicros;
    const share =
      wasted === null || pricedMicros === null || pricedMicros === 0n
        ? null
        : Math.min(1, Number(wastedMicros) / Number(pricedMicros));

    return {
      period: { from, to },
      wasted,
      share,
      runsWithWaste: hits.length,
      largestCause: hits.length === 0 ? null : "cache_write_never_read",
      causes:
        wasted === null
          ? []
          : [
              {
                cause: "cache_write_never_read",
                wasted,
                runs: hits.length,
                runIds: hits.slice(0, CITED_RUNS).map((h) => h.runId),
              },
            ],
    };
  };
}

export const spendWasteHandler = createSpendWasteHandler({ readRunTotals });
