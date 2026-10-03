// audit-exempt: read-only — answers one operator, agent or tool's spend over a trailing window from cost.run_totals; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `get_spend_drill` (ADR-060): the run rows a key attributes to, folded into a
// daily series, per-call and per-run averages, the key's share of the
// workspace's spend over the window, the tokens by class with their cache hit
// rate, the standing context the calls carried, the tools its runs called,
// and the key's figure split by agent, operator and model.
//
// No frame prices a tool call, so a tool drill's money is what the tool's
// results cost as input to the calls that read them: the rollup's per-tool
// estimate, each run's result tokens at that run's uncached input rate
// (ADR-199). The runs already paid that input, so the figure carries the
// `estimated` basis and no share of the workspace.
//
// A drill leaves the in-app assistant's runs out, so it matches its row on the
// Spend page, which leaves the assistant's share out too. The share's divisor
// keeps them, because it is the workspace's whole spend, the figure the page
// total shows. The assistant's own row opens no drill (ADR-235, 2026-10-02
// amendment).
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  type DrillCutRow,
  spendDrill,
  type SpendDrillOutput,
} from "@oxagen/oxagen/contracts/spend.drill";
import type {
  TokenCounts,
  UnmeteredRuns,
} from "@oxagen/oxagen/contracts/spend.shared";
import {
  type CostBasis,
  divideHalfEven,
  foldBasis,
  type RunTotalsRecord,
  utcDay,
} from "@oxagen/billing";
import {
  noOperatorFacts,
  readOperatorFacts,
  type ReadOperatorFacts,
} from "./lib/operator-facts";
import {
  addTokens,
  cost,
  daysBetween,
  money,
  readRunTotals,
  readUnmeteredRuns,
  resultTokensOf,
  runFigure,
  type RunFilter,
  type SpendRunRecord,
  type SpendScope,
  spendOnBasis,
  sumFigures,
  sumStanding,
  tokenCacheHitRate,
  ZERO_TOKENS,
} from "./spend.shared";

export type SpendDrillDeps = {
  readRunTotals: (
    scope: SpendScope,
    q: { from: string; to: string; filter: RunFilter },
  ) => Promise<SpendRunRecord[]>;
  /** The key's wrapped runs that recorded no usage, by harness (#3304). */
  readUnmeteredRuns: (
    scope: SpendScope,
    q: { from: string; to: string; filter: RunFilter },
  ) => Promise<UnmeteredRuns>;
  /** Who each operator key names; a harness that has no store leaves it out. */
  readOperatorFacts?: ReadOperatorFacts;
  now: () => Date;
};

/** The trailing window of `days` days ending today, inclusive. */
export function trailingWindow(days: number, now: Date) {
  const to = utcDay(now);
  const from = utcDay(
    new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000),
  );
  return { from, to };
}

/** One tool's part of one run: its calls, its result tokens, and their estimated input cost. */
interface ToolPart {
  calls: number;
  resultTokens: number | null;
  costMicros: bigint | null;
}

/** What a tool drill counts on a run: that tool's own breakdown rows, summed. */
function toolPart(run: RunTotalsRecord, name: string): ToolPart {
  const part: ToolPart = { calls: 0, resultTokens: null, costMicros: null };
  for (const t of run.breakdown.tools) {
    if (t.name !== name) continue;
    part.calls += t.calls;
    if (t.resultTokens !== null)
      part.resultTokens = (part.resultTokens ?? 0) + t.resultTokens;
    if (t.costMicros !== null)
      part.costMicros = (part.costMicros ?? 0n) + t.costMicros;
  }
  return part;
}

/** One run's part of one cross-cut row, before the rows are summed. */
interface CutPart {
  key: string;
  provider: string | null;
  runId: string;
  calls: number;
  costMicros: bigint | null;
  basis: CostBasis | null;
  currency: string;
  tokens: TokenCounts;
  resultTokens: number | null;
}

type CutRow = Omit<DrillCutRow, "operator">;

/** Costliest first, nothing priced last, then most calls, then by key. */
function compareCutRows(a: CutRow, b: CutRow): number {
  const ac = a.cost === null ? null : BigInt(a.cost.micros);
  const bc = b.cost === null ? null : BigInt(b.cost.micros);
  if (ac !== null && bc !== null && ac !== bc) return ac > bc ? -1 : 1;
  if ((ac === null) !== (bc === null)) return ac === null ? 1 : -1;
  if (a.calls !== b.calls) return b.calls - a.calls;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Sum the parts into one row per key. `runs` counts each run once, however
 * many parts it has, and a cost folds the bases its priced parts carry.
 */
function foldCut(parts: readonly CutPart[]): CutRow[] {
  const byKey = new Map<
    string,
    {
      provider: string | null;
      runs: Set<string>;
      calls: number;
      micros: bigint | null;
      basis: CostBasis | null;
      currency: string;
      tokens: TokenCounts;
      resultTokens: number | null;
    }
  >();
  for (const p of parts) {
    const g = byKey.get(p.key) ?? {
      provider: p.provider,
      runs: new Set<string>(),
      calls: 0,
      micros: null,
      basis: null,
      currency: p.currency,
      tokens: { ...ZERO_TOKENS },
      resultTokens: null,
    };
    g.provider ??= p.provider;
    g.runs.add(p.runId);
    g.calls += p.calls;
    g.currency = p.currency;
    if (p.costMicros !== null && p.basis !== null) {
      g.micros = (g.micros ?? 0n) + p.costMicros;
      g.basis = foldBasis(g.basis, p.basis);
    }
    g.tokens = addTokens(g.tokens, p.tokens);
    if (p.resultTokens !== null)
      g.resultTokens = (g.resultTokens ?? 0) + p.resultTokens;
    byKey.set(p.key, g);
  }
  return [...byKey.entries()]
    .map(([key, g]) => ({
      key,
      provider: g.provider,
      runs: g.runs.size,
      calls: g.calls,
      cost: cost(g.micros, g.currency, g.basis),
      tokens: g.tokens,
      resultTokens: g.resultTokens,
    }))
    .sort(compareCutRows);
}

export function createSpendDrillHandler(
  deps: SpendDrillDeps,
): CapabilityHandler<typeof spendDrill> {
  return async (input, ctx): Promise<SpendDrillOutput> => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const period = trailingWindow(input.days, deps.now());
    const filter: RunFilter = { kind: input.kind, key: input.key };
    const isTool = input.kind === "tool";
    // A tool drill's money is an estimate of input its runs already paid, so
    // no count of unpriced runs belongs beside it.
    const [keyRuns, everyRun, unmeteredRuns] = await Promise.all([
      deps.readRunTotals(scope, { ...period, filter }),
      deps.readRunTotals(scope, { ...period, filter: { kind: "all" } }),
      isTool
        ? Promise.resolve(null)
        : deps.readUnmeteredRuns(scope, { ...period, filter }),
    ]);
    // The key's own runs, without the assistant's.
    const runs = keyRuns.filter((run) => run.inApp !== true);

    // A tool drill counts the tool's calls, and its money is the tool's
    // results priced as input: an estimate, never proven or accepted.
    const partOf = (run: RunTotalsRecord): ToolPart | null =>
      isTool ? toolPart(run, input.key) : null;
    const figureOf = (run: RunTotalsRecord) => {
      const part = partOf(run);
      if (part === null) return runFigure(run);
      return {
        ...runFigure(run),
        costMicros: part.costMicros,
        costBasis: part.costMicros === null ? null : ("estimated" as const),
        calls: part.calls,
        provenMicros: null,
        acceptedMicros: null,
      };
    };

    const total = sumFigures(runs.map(figureOf));

    const byDay = new Map<string, RunTotalsRecord[]>();
    for (const run of runs) {
      const day = utcDay(run.startedAt);
      byDay.set(day, [...(byDay.get(day) ?? []), run]);
    }
    const series = daysBetween(period.from, period.to).map((day) => {
      const f = sumFigures((byDay.get(day) ?? []).map(figureOf));
      return { day, cost: f.cost, calls: f.calls, runs: f.runs };
    });

    const currency = runs[0]?.currency ?? "USD";
    const micros = total.cost === null ? null : BigInt(total.cost.micros);
    const averages = {
      perCall:
        micros === null || total.calls === 0
          ? null
          : money(divideHalfEven(micros, BigInt(total.calls)), currency),
      perRun:
        micros === null || total.runs === 0
          ? null
          : money(divideHalfEven(micros, BigInt(total.runs)), currency),
    };

    // A tool's estimate is part of its runs' cost, so it is no share of the
    // workspace's spend.
    const workspace = sumFigures(everyRun.map(runFigure));
    const workspaceMicros =
      workspace.cost === null ? null : BigInt(workspace.cost.micros);
    const share =
      isTool ||
      micros === null ||
      workspaceMicros === null ||
      workspaceMicros === 0n
        ? null
        : Math.min(1, Number(micros) / Number(workspaceMicros));

    const tokens = runs.reduce<TokenCounts>(
      (sum, run) => addTokens(sum, run.tokens),
      { ...ZERO_TOKENS },
    );

    const tools = new Map<
      string,
      {
        calls: number;
        runs: number;
        resultTokens: number | null;
        micros: bigint | null;
        currency: string;
      }
    >();
    for (const run of runs)
      for (const t of run.breakdown.tools) {
        const g = tools.get(t.name) ?? {
          calls: 0,
          runs: 0,
          resultTokens: null,
          micros: null,
          currency: run.currency,
        };
        g.calls += t.calls;
        g.runs += 1;
        g.currency = run.currency;
        if (t.resultTokens !== null)
          g.resultTokens = (g.resultTokens ?? 0) + t.resultTokens;
        if (t.costMicros !== null) g.micros = (g.micros ?? 0n) + t.costMicros;
        tools.set(t.name, g);
      }
    const byTool = [...tools.entries()]
      .map(([name, g]) => ({
        name,
        calls: g.calls,
        runs: g.runs,
        resultTokens: g.resultTokens,
        cost: cost(g.micros, g.currency, g.micros === null ? null : "estimated"),
      }))
      .sort((a, b) => b.calls - a.calls || (a.name < b.name ? -1 : 1));

    // A run is in the agent row and the operator row it names, whole on an
    // operator or agent drill, and as the tool's part on a tool drill.
    const wholeParts = (keyOf: (run: RunTotalsRecord) => string | null) =>
      runs.flatMap((run): CutPart[] => {
        const key = keyOf(run);
        if (key === null) return [];
        const f = figureOf(run);
        return [
          {
            key,
            provider: null,
            runId: run.runId,
            calls: f.calls,
            costMicros: f.costMicros,
            basis: f.costBasis,
            currency: run.currency,
            tokens: run.tokens,
            resultTokens: partOf(run)?.resultTokens ?? null,
          },
        ];
      });
    // A model row is that model's calls in the key's runs. A tool's estimate
    // is no model's money, so a tool drill has no model rows.
    const modelParts = isTool
      ? []
      : runs.flatMap((run) =>
          run.breakdown.models.map(
            (m): CutPart => ({
              key: m.model,
              provider: m.provider,
              runId: run.runId,
              calls: m.calls,
              costMicros: m.costMicros,
              basis: m.basis,
              currency: run.currency,
              tokens: m.tokens,
              resultTokens: null,
            }),
          ),
        );
    const operatorRows = foldCut(wholeParts((run) => run.operatorKey));
    // An operator key is a principal id, which is a key and not a label. The
    // person it names rides beside it, so the page prints a name.
    const facts = await (deps.readOperatorFacts ?? noOperatorFacts)(
      scope,
      operatorRows.map((row) => row.key),
    );

    return {
      kind: input.kind,
      key: input.key,
      period,
      total,
      series,
      averages,
      share,
      tokens,
      cacheHitRate: tokenCacheHitRate(tokens),
      modelCalls: runs.reduce((sum, run) => sum + run.modelCalls, 0),
      observed: isTool ? null : spendOnBasis(runs, "gateway_observed"),
      standing: sumStanding(runs),
      resultTokens: resultTokensOf(runs, isTool ? input.key : undefined),
      byTool,
      byAgent: foldCut(wholeParts((run) => run.agentKey)).map((row) => ({
        ...row,
        operator: null,
      })),
      byOperator: operatorRows.map((row) => ({
        ...row,
        operator: facts.get(row.key) ?? null,
      })),
      byModel: foldCut(modelParts).map((row) => ({ ...row, operator: null })),
      ...(unmeteredRuns === null ? {} : { unmeteredRuns }),
    };
  };
}

export const spendDrillHandler = createSpendDrillHandler({
  readRunTotals,
  readUnmeteredRuns,
  readOperatorFacts,
  now: () => new Date(),
});
