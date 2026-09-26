// audit-exempt: read-only — answers one operator, agent or tool's spend over a trailing window from cost.run_totals; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `get_spend_drill` (ADR-060): the run rows a key attributes to, folded into a
// daily series, per-call and per-run averages, the key's share of the
// workspace's spend over the window, and the tools its runs called. A tool
// drill carries counts and no money: no frame prices a tool call.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  spendDrill,
  type SpendDrillOutput,
} from "@oxagen/oxagen/contracts/spend.drill";
import type { UnmeteredRuns } from "@oxagen/oxagen/contracts/spend.shared";
import { divideHalfEven, type RunTotalsRecord, utcDay } from "@oxagen/billing";
import {
  daysBetween,
  money,
  readRunTotals,
  readUnmeteredRuns,
  runFigure,
  type RunFilter,
  type SpendScope,
  sumFigures,
} from "./spend.shared";

export type SpendDrillDeps = {
  readRunTotals: (
    scope: SpendScope,
    q: { from: string; to: string; filter: RunFilter },
  ) => Promise<RunTotalsRecord[]>;
  /** The key's wrapped runs that recorded no usage, by harness (#3304). */
  readUnmeteredRuns: (
    scope: SpendScope,
    q: { from: string; to: string; filter: RunFilter },
  ) => Promise<UnmeteredRuns>;
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

/** What a tool drill counts on each run: that tool's own calls, summed over its breakdown rows. */
function toolCalls(run: RunTotalsRecord, name: string): number {
  let calls = 0;
  for (const t of run.breakdown.tools) if (t.name === name) calls += t.calls;
  return calls;
}

export function createSpendDrillHandler(
  deps: SpendDrillDeps,
): CapabilityHandler<typeof spendDrill> {
  return async (input, ctx): Promise<SpendDrillOutput> => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const period = trailingWindow(input.days, deps.now());
    const filter: RunFilter = { kind: input.kind, key: input.key };
    const isTool = input.kind === "tool";
    // A tool drill carries no money, so no total of its leaves a cost out.
    const [runs, everyRun, unmeteredRuns] = await Promise.all([
      deps.readRunTotals(scope, { ...period, filter }),
      deps.readRunTotals(scope, { ...period, filter: { kind: "all" } }),
      isTool
        ? Promise.resolve(null)
        : deps.readUnmeteredRuns(scope, { ...period, filter }),
    ]);

    // A tool drill counts the tool's calls and carries no money.
    const figureOf = (run: RunTotalsRecord) =>
      isTool
        ? {
            ...runFigure(run),
            costMicros: null,
            costBasis: null,
            calls: toolCalls(run, input.key),
            provenMicros: null,
            acceptedMicros: null,
          }
        : runFigure(run);

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

    const workspace = sumFigures(everyRun.map(runFigure));
    const workspaceMicros =
      workspace.cost === null ? null : BigInt(workspace.cost.micros);
    const share =
      micros === null || workspaceMicros === null || workspaceMicros === 0n
        ? null
        : Math.min(1, Number(micros) / Number(workspaceMicros));

    const tools = new Map<string, { calls: number; runs: number }>();
    for (const run of runs)
      for (const t of run.breakdown.tools) {
        const g = tools.get(t.name) ?? { calls: 0, runs: 0 };
        g.calls += t.calls;
        g.runs += 1;
        tools.set(t.name, g);
      }
    const byTool = [...tools.entries()]
      .map(([name, g]) => ({ name, ...g }))
      .sort((a, b) => b.calls - a.calls || (a.name < b.name ? -1 : 1));

    return {
      kind: input.kind,
      key: input.key,
      period,
      total,
      series,
      averages,
      share,
      byTool,
      ...(unmeteredRuns === null ? {} : { unmeteredRuns }),
    };
  };
}

export const spendDrillHandler = createSpendDrillHandler({
  readRunTotals,
  readUnmeteredRuns,
  now: () => new Date(),
});
