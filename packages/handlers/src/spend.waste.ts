// audit-exempt: read-only — answers wasted spend by cause from cost.run_totals and cost.finding_claims; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `list_waste` (ADR-060, ADR-208, #5294): each cause is a pattern the record
// shows, with the money on it and the runs that prove it. Two sources feed it:
//
// - A cache written and never read (spec §12.8 "Cache writes never read"),
//   from the runs that started in the period: the run wrote prompt-cache
//   tokens and read none, so every cache write it paid for bought nothing.
// - The calls that open and applied findings of detectors 1, 7, and 8 claim,
//   by the time each call ran in the period. A call counts once, under the
//   lowest detector that claims it and then the first cause in
//   WASTE_CLAIM_CAUSES, the rule `countClaims` counts the unproductive spend
//   headline by. So these causes sum to that headline for the same period,
//   and `wasted` is the headline plus the cache-write cause.
//
// A run whose calls a finding claims in the period is left out of the
// cache-write cause. The claim counts each of those calls whole, cache write
// included, and the rollup has no split by call to take the write out.
//
// A cause covers the runs it cites, so the in-app assistant's runs are left
// out of every cause: its money, its run count, and its run ids. The share's
// divisor is the period's priced spend, the figure the Spend tile prints, so
// it keeps them. The workspace does not monitor the assistant (ADR-235,
// 2026-10-02 amendment).
import { type CapabilityHandler, HandlerError } from "@oxagen/oxagen";
import {
  spendWasteList,
  type SpendWasteListOutput,
  WASTE_CLAIM_CAUSES,
  type WasteCause,
} from "@oxagen/oxagen/contracts/spend.waste";
import {
  type CostBasis,
  dayBounds,
  foldBasis,
  type RunTotalsRecord,
} from "@oxagen/billing";
import {
  type CauseClaim,
  type ClaimWindow,
  countFindingsOutside,
  readCauseClaims,
} from "./lib/finding-claims";
import { readRunNames } from "./lib/run-names";
import {
  cost,
  readRunTotals,
  type RunFilter,
  type SpendRunRecord,
  type SpendScope,
} from "./spend.shared";

export type SpendWasteDeps = {
  readRunTotals: (
    scope: SpendScope,
    q: { from: string; to: string; filter: RunFilter },
  ) => Promise<SpendRunRecord[]>;
  /** The calls open and applied findings claim in the window, with each finding's kind. */
  readClaims: (scope: SpendScope, window: ClaimWindow) => Promise<CauseClaim[]>;
  /** The open findings whose calls all ran outside the window. */
  countFindingsOutside: (
    scope: SpendScope,
    window: ClaimWindow,
  ) => Promise<number>;
  /** The session name of each cited run, so the page names it (#4571). */
  readRunNames: typeof readRunNames;
};

const CITED_RUNS = 10;

/** Every cause in the order a tie between two of them breaks. */
const CAUSE_ORDER: readonly WasteCause[] = [
  "cache_write_never_read",
  ...WASTE_CLAIM_CAUSES.map((c) => c.cause),
];

/** Each claiming finding kind's cause, with that cause's place in counting order. */
const CAUSE_OF_KIND = new Map<string, { cause: WasteCause; rank: number }>(
  WASTE_CLAIM_CAUSES.flatMap((c, rank) =>
    c.kinds.map((kind) => [kind, { cause: c.cause, rank }] as const),
  ),
);

/** What one run adds to one cause. */
export type WasteHit = {
  cause: WasteCause;
  runId: string;
  micros: bigint;
  basis: CostBasis;
  currency: string;
};

/**
 * The cache-write cost of a run that read nothing back, or null when the
 * pattern is absent or the rollup put no money on it: an `estimated` run
 * carries one reported figure with no split by class, and a book that prices
 * cache writes at nothing wasted nothing.
 */
export function cacheWriteNeverRead(
  run: RunTotalsRecord,
): { micros: bigint; basis: CostBasis } | null {
  const wrote = run.tokens.cache_write_5m + run.tokens.cache_write_1h;
  if (
    wrote === 0 ||
    run.tokens.cache_read > 0 ||
    run.costBasis === null ||
    run.costBasis === "estimated"
  )
    return null;
  let micros = 0n;
  for (const m of run.breakdown.models)
    micros += m.costByClass.cache_write_5m + m.costByClass.cache_write_1h;
  if (micros === 0n) return null;
  return { micros, basis: run.costBasis };
}

/**
 * Each claimed call once, under the lowest detector that claims it and then
 * the earliest cause in counting order, summed per cause and run. A claim of
 * a kind no cause names is left out: every kind a counting detector writes
 * has a cause, and the handler test fails when one does not.
 */
export function claimedHits(rows: readonly CauseClaim[]): WasteHit[] {
  const first = new Map<
    string,
    { row: CauseClaim; cause: WasteCause; rank: number }
  >();
  for (const row of rows) {
    const named = CAUSE_OF_KIND.get(row.kind);
    if (named === undefined) continue;
    const key = `${row.runId}\u0000${row.frameKey}`;
    const held = first.get(key);
    if (
      held === undefined ||
      row.detector < held.row.detector ||
      (row.detector === held.row.detector && named.rank < held.rank)
    )
      first.set(key, { row, ...named });
  }
  const byRun = new Map<string, WasteHit>();
  for (const { row, cause } of first.values()) {
    const key = `${cause}\u0000${row.runId}`;
    const held = byRun.get(key);
    if (held === undefined)
      byRun.set(key, {
        cause,
        runId: row.runId,
        micros: row.costMicros,
        basis: row.basis,
        currency: row.currency,
      });
    else {
      held.micros += row.costMicros;
      held.basis = foldBasis(held.basis, row.basis);
    }
  }
  return [...byRun.values()];
}

/** Largest first; equal amounts by run id, so the cited runs are stable. */
function byMicros(
  a: { micros: bigint; runId: string },
  b: { micros: bigint; runId: string },
): number {
  if (a.micros !== b.micros) return a.micros > b.micros ? -1 : 1;
  return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
}

export function createSpendWasteHandler(
  deps: SpendWasteDeps,
): CapabilityHandler<typeof spendWasteList> {
  return async (input, ctx): Promise<SpendWasteListOutput> => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const { from, to } = input.period;
    const window = { start: dayBounds(from).start, end: dayBounds(to).next };
    const [runs, claims, findingsOutsidePeriod] = await Promise.all([
      deps.readRunTotals(scope, { from, to, filter: { kind: "all" } }),
      deps.readClaims(scope, window),
      deps.countFindingsOutside(scope, window),
    ]);

    const claimed = claimedHits(claims);
    const claimedRuns = new Set(claimed.map((h) => h.runId));
    const cacheHits: WasteHit[] = runs
      .filter((run) => run.inApp !== true && !claimedRuns.has(run.runId))
      .flatMap((run) => {
        const waste = cacheWriteNeverRead(run);
        return waste
          ? [
              {
                cause: "cache_write_never_read" as const,
                runId: run.runId,
                currency: run.currency,
                ...waste,
              },
            ]
          : [];
      });
    const hits = [...cacheHits, ...claimed];

    const currencies = [
      ...new Set([
        ...claims.map((c) => c.currency),
        ...cacheHits.map((h) => h.currency),
      ]),
    ].sort();
    if (currencies.length > 1)
      throw new HandlerError({
        code: "conflict",
        reason: "waste_mixed_currency",
        message: `The period holds wasted spend priced in ${currencies.join(" and in ")}. The total adds one currency, so none was built.`,
      });
    const currency = currencies[0] ?? runs[0]?.currency ?? "USD";

    const byCause = new Map<WasteCause, WasteHit[]>();
    for (const hit of hits) {
      const list = byCause.get(hit.cause) ?? [];
      list.push(hit);
      byCause.set(hit.cause, list);
    }
    const totals = [...byCause.entries()]
      .map(([cause, list]) => ({
        cause,
        micros: list.reduce((sum, h) => sum + h.micros, 0n),
        basis: list
          .map((h) => h.basis)
          .reduce<CostBasis | null>(foldBasis, null),
        runs: [...list].sort(byMicros),
      }))
      .sort((a, b) =>
        a.micros !== b.micros
          ? a.micros > b.micros
            ? -1
            : 1
          : CAUSE_ORDER.indexOf(a.cause) - CAUSE_ORDER.indexOf(b.cause),
      );

    const wastedMicros = hits.reduce((sum, h) => sum + h.micros, 0n);
    const basis = hits
      .map((h) => h.basis)
      .reduce<CostBasis | null>(foldBasis, null);
    const wasted =
      hits.length === 0 ? null : cost(wastedMicros, currency, basis);
    const cited = new Map(
      totals.map(
        (t) =>
          [t.cause, t.runs.slice(0, CITED_RUNS).map((h) => h.runId)] as const,
      ),
    );
    const names = await deps.readRunNames(scope, [
      ...new Set([...cited.values()].flat()),
    ]);

    let pricedMicros: bigint | null = null;
    for (const run of runs)
      if (run.costMicros !== null)
        pricedMicros =
          pricedMicros === null
            ? run.costMicros
            : pricedMicros + run.costMicros;
    const share =
      wasted === null || pricedMicros === null || pricedMicros === 0n
        ? null
        : Math.min(1, Number(wastedMicros) / Number(pricedMicros));

    return {
      period: { from, to },
      wasted,
      share,
      runsWithWaste: new Set(hits.map((h) => h.runId)).size,
      largestCause: totals[0]?.cause ?? null,
      causes: totals.flatMap((t) => {
        const money = cost(t.micros, currency, t.basis);
        if (money === null) return [];
        const runIds = cited.get(t.cause) ?? [];
        return [
          {
            cause: t.cause,
            wasted: money,
            runs: t.runs.length,
            runIds,
            provingRuns: runIds.map((runId) => ({
              runId,
              name: names.get(runId) ?? null,
            })),
          },
        ];
      }),
      findingsOutsidePeriod,
    };
  };
}

export const spendWasteHandler = createSpendWasteHandler({
  readRunTotals,
  readClaims: readCauseClaims,
  countFindingsOutside,
  readRunNames,
});
