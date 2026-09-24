// audit-exempt: read-only — answers the workspace's spend rollup at one level from cost.daily_totals and cost.run_totals; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `get_spend`: the Spend page's rollup at one level (ADR-060). The rows come
// from `cost.daily_totals` for the level asked for; the period total comes
// from the run rows, since a level's groups only hold the runs that name a
// key at that level (a run with no operator is not attributed to any
// operator, spec §12.7) and a run appears under every model it used.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  spendGet,
  type SpendGetOutput,
  type SpendRow,
} from "@oxagen/oxagen/contracts/spend.get";
import type { TokenCounts } from "@oxagen/oxagen/contracts/spend.shared";
import type { DailyTotalsRecord, RunTotalsRecord } from "@oxagen/billing";
import {
  noOperatorFacts,
  readOperatorFacts,
  type ReadOperatorFacts,
} from "./lib/operator-facts";
import {
  addTokens,
  readDailyTotals,
  readRunTotals,
  runFigure,
  type SpendScope,
  sumFigures,
  ZERO_TOKENS,
} from "./spend.shared";

export type SpendGetDeps = {
  readDailyTotals: typeof readDailyTotals;
  readRunTotals: (
    scope: SpendScope,
    q: { from: string; to: string },
  ) => Promise<RunTotalsRecord[]>;
  /** Who each operator key names; a harness that has no store leaves it out. */
  readOperatorFacts?: ReadOperatorFacts;
};

/** Sum a level's day rows into one row per key. */
export function groupRows(rows: readonly DailyTotalsRecord[]): SpendRow[] {
  const byKey = new Map<
    string,
    { provider: string | null; tokens: TokenCounts; days: DailyTotalsRecord[] }
  >();
  for (const row of rows) {
    const g = byKey.get(row.groupKey) ?? {
      provider: row.provider,
      tokens: { ...ZERO_TOKENS },
      days: [],
    };
    g.provider ??= row.provider;
    g.tokens = addTokens(g.tokens, row.tokens);
    g.days.push(row);
    byKey.set(row.groupKey, g);
  }
  return [...byKey.entries()]
    .map(([key, g]) => ({
      key,
      provider: g.provider,
      tokens: g.tokens,
      operator: null,
      ...sumFigures(g.days),
    }))
    .sort(compareRows);
}

/** Largest spend first; groups with no cost after those with one; then by key. */
export function compareRows(a: SpendRow, b: SpendRow): number {
  const ac = a.cost === null ? null : BigInt(a.cost.micros);
  const bc = b.cost === null ? null : BigInt(b.cost.micros);
  if (ac !== null && bc !== null && ac !== bc) return ac > bc ? -1 : 1;
  if ((ac === null) !== (bc === null)) return ac === null ? 1 : -1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function createSpendGetHandler(
  deps: SpendGetDeps,
): CapabilityHandler<typeof spendGet> {
  return async (input, ctx): Promise<SpendGetOutput> => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const { from, to } = input.period;
    const [rows, runs] = await Promise.all([
      deps.readDailyTotals(scope, { from, to, groupKind: input.groupBy }),
      deps.readRunTotals(scope, { from, to }),
    ]);
    const grouped = groupRows(rows);
    // An operator row's key is a principal id, which is a key and not a
    // label. The person it names rides beside it, so the page prints a name.
    const facts =
      input.groupBy === "operator"
        ? await (deps.readOperatorFacts ?? noOperatorFacts)(
            scope,
            grouped.map((row) => row.key),
          )
        : new Map<string, never>();
    return {
      period: { from, to },
      groupBy: input.groupBy,
      total: sumFigures(runs.map(runFigure)),
      // An open run's row is its running estimate; the page says how many
      // of the period's runs that is.
      estimatedRuns: runs.filter((run) => run.sealedAt === null).length,
      rows: grouped.map((row) => ({
        ...row,
        operator: facts.get(row.key) ?? null,
      })),
    };
  };
}

export const spendGetHandler = createSpendGetHandler({
  readDailyTotals,
  readRunTotals: (scope, q) =>
    readRunTotals(scope, { ...q, filter: { kind: "all" } }),
  readOperatorFacts,
});
