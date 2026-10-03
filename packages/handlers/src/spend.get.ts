// audit-exempt: read-only — answers the workspace's spend rollup at one level from cost.daily_totals and cost.run_totals; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `get_spend`: the Spend page's rollup at one level (ADR-060). The rows come
// from `cost.daily_totals` for the level asked for; the period total comes
// from the run rows, since a level's groups only hold the runs that name a
// key at that level (a run with no operator is not attributed to any
// operator, spec §12.7) and a run appears under every model it used.
//
// The run rows also give the spend by day, each row's costliest runs, and
// the `mcp_server` grouping, which the daily rollup does not store.
//
// The in-app assistant's spend is one row of its own, keyed
// `ASSISTANT_SPEND_KEY`, in every grouping (ADR-235, 2026-10-02 amendment).
// The other rows leave its share out, and the total, the days, and the
// reported spend still count it, so the rows sum to the total. The row lists
// no runs, because the workspace does not monitor the assistant.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  ASSISTANT_SPEND_KEY,
  OTHER_SPEND_KEY,
  SPEND_TOP_RUNS_MAX,
  spendGet,
  type SpendGetOutput,
  type SpendGroupBy,
  type SpendRow,
  type SpendTokenSources,
  type SpendTopRun,
} from "@oxagen/oxagen/contracts/spend.get";
import {
  type TokenCounts,
  UNASSIGNED_COST_CENTER_KEY,
  type UnmeteredRuns,
} from "@oxagen/oxagen/contracts/spend.shared";
import {
  type CostBasis,
  type DailyTotalsRecord,
  foldBasis,
  type RunTotalsRecord,
  utcDay,
} from "@oxagen/billing";
import { bareToolName } from "@oxagen/run-ledger";
import {
  noOperatorFacts,
  readOperatorFacts,
  type ReadOperatorFacts,
} from "./lib/operator-facts";
import { readAgentHarnesses, readRunHarnesses } from "./lib/run-harnesses";
import { readRunNames } from "./lib/run-names";
import {
  addTokens,
  cost,
  daysBetween,
  readDailyTotals,
  readRunTotals,
  readUnmeteredRuns,
  resultTokensOf,
  runFigure,
  type SpendRunRecord,
  type SpendScope,
  spendOnBasis,
  sumFigures,
  sumStanding,
  ZERO_TOKENS,
} from "./spend.shared";

export type SpendGetDeps = {
  readRunHarnesses: typeof readRunHarnesses;
  /** The harness each agent registered, for a top run that recorded none. */
  readAgentHarnesses?: typeof readAgentHarnesses;
  readDailyTotals: typeof readDailyTotals;
  readRunTotals: (
    scope: SpendScope,
    q: { from: string; to: string },
  ) => Promise<SpendRunRecord[]>;
  /** Who each operator key names; a harness that has no store leaves it out. */
  readOperatorFacts?: ReadOperatorFacts;
  /** The period's wrapped runs that recorded no usage, by harness (#3304). */
  readUnmeteredRuns: (
    scope: SpendScope,
    q: { from: string; to: string },
  ) => Promise<UnmeteredRuns>;
  /** The session name of each run a row lists (#4571). */
  readRunNames: (
    scope: SpendScope,
    runIds: readonly string[],
  ) => Promise<Map<string, string | null>>;
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
      topRuns: [],
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

/** One row's part of one run: the cost, calls and tokens the run adds to it. */
export interface RunShare {
  key: string;
  micros: bigint | null;
  basis: CostBasis | null;
  calls: number;
  tokens: TokenCounts;
}

/**
 * The MCP server a tool name calls (`mcp__<server>__<tool>`), after the
 * harness prefix a gateway adds; null for a tool no MCP server serves.
 */
export function mcpServerOf(tool: string): string | null {
  return /^mcp__(.+?)__./.exec(bareToolName(tool))?.[1] ?? null;
}

/**
 * What one run adds to each MCP server row, and to the row for the rest.
 * A server's part is its tools' result tokens at the run's uncached input
 * rate (ADR-199): input the run's own cost already counts. The rest is the
 * run's cost less every server's part, so the rows sum to the run. Only a
 * run that called a priced server tool has an estimated remainder; any
 * other run's remainder is its whole cost at its own basis. When the
 * servers' estimates come to more than the run cost, as when a run ends on a
 * large result no model call read, the servers split the run's cost in
 * proportion and the rest is what their rounding leaves.
 */
export function mcpServerShares(run: RunTotalsRecord): RunShare[] {
  const servers = new Map<string, RunShare>();
  let serverMicros = 0n;
  let serverCalls = 0;
  let serverTokens = 0;
  for (const tool of run.breakdown.tools) {
    const key = mcpServerOf(tool.name);
    if (key === null) continue;
    const share = servers.get(key) ?? {
      key,
      micros: null,
      basis: null,
      calls: 0,
      tokens: { ...ZERO_TOKENS },
    };
    share.calls += tool.calls;
    share.tokens.input_uncached += tool.resultTokens ?? 0;
    if (tool.costMicros !== null) {
      share.micros = (share.micros ?? 0n) + tool.costMicros;
      share.basis = "estimated";
      serverMicros += tool.costMicros;
    }
    servers.set(key, share);
    serverCalls += tool.calls;
    serverTokens += tool.resultTokens ?? 0;
  }
  const estimated = serverMicros > 0n;
  if (run.costMicros !== null && serverMicros > run.costMicros) {
    let scaled = 0n;
    for (const share of servers.values()) {
      if (share.micros === null) continue;
      share.micros = (share.micros * run.costMicros) / serverMicros;
      scaled += share.micros;
    }
    serverMicros = scaled;
  }
  const rest: RunShare = {
    key: OTHER_SPEND_KEY,
    micros: run.costMicros === null ? null : run.costMicros - serverMicros,
    basis:
      run.costBasis === null
        ? null
        : estimated
          ? foldBasis(run.costBasis, "estimated")
          : run.costBasis,
    calls: Math.max(0, run.steps - serverCalls),
    tokens: {
      ...run.tokens,
      input_uncached: Math.max(0, run.tokens.input_uncached - serverTokens),
    },
  };
  return [...servers.values(), rest];
}

/** What one run adds to each row of a grouping. */
export function runShares(
  run: RunTotalsRecord,
  groupBy: SpendGroupBy,
): RunShare[] {
  const whole = (key: string | null): RunShare[] =>
    key === null
      ? []
      : [
          {
            key,
            micros: run.costMicros,
            basis: run.costBasis,
            calls: run.steps,
            tokens: run.tokens,
          },
        ];
  switch (groupBy) {
    case "operator":
      return whole(run.operatorKey);
    case "agent":
      return whole(run.agentKey);
    case "task":
      return whole(run.taskRef);
    case "cost_center":
      return whole(run.costCenter ?? UNASSIGNED_COST_CENTER_KEY);
    case "model":
      return run.breakdown.models.map((m) => ({
        key: m.model,
        micros: m.costMicros,
        basis: m.basis,
        calls: m.calls,
        tokens: m.tokens,
      }));
    case "tool":
      // No frame prices a tool call (spec §12.3), so a tool's part of a run
      // carries calls and no money, as the tool level's rows do.
      return run.breakdown.tools.map((t) => ({
        key: t.name,
        micros: null,
        basis: null,
        calls: t.calls,
        tokens: { ...ZERO_TOKENS },
      }));
    case "mcp_server":
      return mcpServerShares(run);
  }
}

type Attributed = { run: SpendRunRecord; share: RunShare };

/**
 * The groupings whose rows hold whole runs, so each run's prompt sources
 * belong to its row. A model, tool, or MCP server row holds part of a run,
 * and the sources are not split by model or tool, so those rows carry none.
 */
const WHOLE_RUN_GROUPINGS: ReadonlySet<SpendGroupBy> = new Set([
  "operator",
  "agent",
  "task",
  "cost_center",
]);

/**
 * A row's prompt sources (#5295): each run's tool definition, context frame
 * and steering tokens, which the rollup stores beside its record, and its
 * tools' result tokens, summed over the row's runs. A source no run measured
 * stays null, never a zero, so a row of runs the proxy never carried says
 * its tool definitions were not recorded.
 */
export function tokenSourcesOf(
  runs: readonly SpendRunRecord[],
): SpendTokenSources {
  // The drill sums the same sources with the same helpers, so a row and the
  // drill it opens agree.
  return { ...sumStanding(runs), toolResultTokens: resultTokensOf(runs) };
}

/** Each run of `list` once, in the order first seen. */
function runsOf(list: readonly Attributed[]): SpendRunRecord[] {
  const seen = new Map<string, SpendRunRecord>();
  for (const { run } of list) if (!seen.has(run.runId)) seen.set(run.runId, run);
  return [...seen.values()];
}

/** Costliest first, then most calls, then newest; nothing priced sorts last. */
function compareShares(a: Attributed, b: Attributed): number {
  const am = a.share.micros;
  const bm = b.share.micros;
  if (am !== null && bm !== null && am !== bm) return am > bm ? -1 : 1;
  if ((am === null) !== (bm === null)) return am === null ? 1 : -1;
  if (a.share.calls !== b.share.calls) return b.share.calls - a.share.calls;
  const at = a.run.startedAt.getTime();
  const bt = b.run.startedAt.getTime();
  if (at !== bt) return bt - at;
  return a.run.runId < b.run.runId ? -1 : 1;
}

/** Every row's runs, keyed by the row's key. */
function attribute(
  runs: readonly SpendRunRecord[],
  groupBy: SpendGroupBy,
): Map<string, Attributed[]> {
  const byKey = new Map<string, Attributed[]>();
  for (const run of runs)
    for (const share of runShares(run, groupBy)) {
      const list = byKey.get(share.key) ?? [];
      list.push({ run, share });
      byKey.set(share.key, list);
    }
  return byKey;
}

/** A share as a figure: the run's figure with the share's cost and calls. */
function shareFigure({ run, share }: Attributed) {
  return {
    ...runFigure({ ...run, costMicros: share.micros, costBasis: share.basis }),
    calls: share.calls,
  };
}

/** The `mcp_server` rows: each server, costliest first, then the rest. */
export function mcpServerRows(byKey: Map<string, Attributed[]>): SpendRow[] {
  const rowOf = (key: string, list: readonly Attributed[]): SpendRow => ({
    key,
    provider: null,
    operator: null,
    topRuns: [],
    tokens: list.reduce<TokenCounts>(
      (sum, a) => addTokens(sum, a.share.tokens),
      { ...ZERO_TOKENS },
    ),
    ...sumFigures(list.map(shareFigure)),
  });
  const servers = [...byKey.entries()]
    .filter(([key]) => key !== OTHER_SPEND_KEY)
    .map(([key, list]) => rowOf(key, list))
    .sort(compareRows);
  const rest = byKey.get(OTHER_SPEND_KEY);
  return rest === undefined
    ? servers
    : [...servers, rowOf(OTHER_SPEND_KEY, rest)];
}

/** The period's in-app runs and every other run, apart. */
function splitInApp(runs: readonly SpendRunRecord[]): {
  inApp: SpendRunRecord[];
  rest: SpendRunRecord[];
} {
  const inApp: SpendRunRecord[] = [];
  const rest: SpendRunRecord[] = [];
  for (const run of runs) (run.inApp === true ? inApp : rest).push(run);
  return { inApp, rest };
}

/** Each token class less the other's, never below zero. */
function subtractTokens(from: TokenCounts, less: TokenCounts): TokenCounts {
  const out = { ...from };
  for (const k of Object.keys(ZERO_TOKENS) as (keyof TokenCounts)[])
    out[k] = Math.max(0, from[k] - less[k]);
  return out;
}

/**
 * A daily row with the in-app assistant's part taken out (ADR-235). The daily
 * rollup folds an assistant run into every operator, agent, model, tool, task,
 * and cost-center key it names, and the {@link ASSISTANT_SPEND_KEY} row
 * carries that spend instead. `inApp` is the key's in-app shares, as
 * `runShares` attributes them, and `rest` the key's other shares. Each figure
 * is handled on its own terms:
 *
 * - Cost, calls, runs, and tokens lose the in-app shares. None falls below
 *   zero.
 * - The basis is folded again from the remaining shares, since a folded basis
 *   cannot be unfolded. A key with no remaining priced share keeps its own.
 * - The productive ratio loses each graded in-app run's advanced steps over
 *   its steps, the weight the daily rollup gave it.
 * - Proven and accepted spend stay as they are. An assistant run carries
 *   neither, since no witness or reviewer grades it.
 *
 * Null when nothing is left: no run and no cost.
 */
function withoutInAppShares(
  row: SpendRow,
  days: readonly DailyTotalsRecord[],
  inApp: readonly Attributed[],
  rest: readonly Attributed[],
): SpendRow | null {
  if (inApp.length === 0) return row;
  let micros = row.cost === null ? null : BigInt(row.cost.micros);
  let calls = row.calls;
  let tokens = row.tokens;
  for (const { share } of inApp) {
    if (micros !== null && share.micros !== null) micros -= share.micros;
    calls -= share.calls;
    tokens = subtractTokens(tokens, share.tokens);
  }
  if (micros !== null && micros < 0n) micros = 0n;
  const runs = Math.max(0, row.runs - inApp.length);
  const restBasis = rest
    .flatMap(({ share }) =>
      share.micros === null || share.basis === null ? [] : [share.basis],
    )
    .reduce<CostBasis | null>(foldBasis, null);
  const left =
    micros === null || row.cost === null
      ? null
      : restBasis === null && micros === 0n
        ? null
        : cost(micros, row.cost.currency, restBasis ?? row.cost.basis);
  if (runs === 0 && left === null) return null;
  // The ratio's sum and weight as `sumFigures` builds them from the days,
  // less each graded in-app run.
  let advanced = 0;
  let weight = 0;
  for (const day of days) {
    if (day.productiveRatio === null) continue;
    const w = day.gradedSteps ?? Math.max(1, day.runs);
    advanced += day.productiveRatio * w;
    weight += w;
  }
  for (const { run } of inApp) {
    if (run.advancedSteps === null) continue;
    advanced -= run.advancedSteps;
    weight -= run.steps;
  }
  return {
    ...row,
    cost: left,
    calls: Math.max(0, calls),
    runs,
    tokens,
    productiveRatio:
      weight <= 0 ? null : Math.min(1, Math.max(0, advanced / weight)),
  };
}

/**
 * The {@link ASSISTANT_SPEND_KEY} row: the in-app runs' shares in this
 * grouping, summed. `runs` counts each run once, however many shares it has.
 * The row lists no runs and names no operator or provider. Its proven and
 * accepted spend and its productive ratio are null, since the workspace does
 * not grade the assistant. Null when no in-app run has a share.
 */
function assistantRow(byKey: Map<string, Attributed[]>): SpendRow | null {
  const shares = [...byKey.values()].flat();
  if (shares.length === 0) return null;
  const figure = sumFigures(shares.map(shareFigure));
  return {
    key: ASSISTANT_SPEND_KEY,
    provider: null,
    operator: null,
    topRuns: [],
    tokens: shares.reduce<TokenCounts>(
      (sum, a) => addTokens(sum, a.share.tokens),
      { ...ZERO_TOKENS },
    ),
    ...figure,
    runs: new Set(shares.map((a) => a.run.runId)).size,
    proven: null,
    accepted: null,
    productiveRatio: null,
  };
}

/** The period's spend by day, every day included. */
function spendByDay(
  runs: readonly RunTotalsRecord[],
  from: string,
  to: string,
): SpendGetOutput["days"] {
  const byDay = new Map<string, RunTotalsRecord[]>();
  for (const run of runs) {
    const day = utcDay(run.startedAt);
    const list = byDay.get(day) ?? [];
    list.push(run);
    byDay.set(day, list);
  }
  return daysBetween(from, to).map((day) => {
    const f = sumFigures((byDay.get(day) ?? []).map(runFigure));
    return { day, cost: f.cost, calls: f.calls, runs: f.runs };
  });
}

/**
 * The part of the period's spend the harness reported: every model whose
 * frames were all `client_attested`. A run rolled up before its breakdown
 * existed counts whole when its own basis is `client_attested`.
 */
export function reportedSpend(
  runs: readonly RunTotalsRecord[],
): SpendGetOutput["reported"] {
  return spendOnBasis(runs, "client_attested");
}

/**
 * The part of the period's spend the gateway metered: every model whose
 * frames were all `gateway_observed`, the other side of {@link reportedSpend}.
 */
export function observedSpend(
  runs: readonly RunTotalsRecord[],
): SpendGetOutput["reported"] {
  return spendOnBasis(runs, "gateway_observed");
}

/**
 * What the period's model calls carried besides the conversation: the
 * standing context by source and the tool results, from the run rows (#4493,
 * ADR-199). A part no run recorded is null.
 */
export function promptComposition(
  runs: readonly SpendRunRecord[],
): NonNullable<SpendGetOutput["composition"]> {
  return { ...sumStanding(runs), toolResultTokens: resultTokensOf(runs) };
}

export function createSpendGetHandler(
  deps: SpendGetDeps,
): CapabilityHandler<typeof spendGet> {
  return async (input, ctx): Promise<SpendGetOutput> => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const { from, to } = input.period;
    const groupBy = input.groupBy;
    // The daily rollup stores every level but `mcp_server`, which the run
    // rows below answer on their own.
    const [dailyRows, runs, unmeteredRuns] = await Promise.all([
      groupBy === "mcp_server"
        ? Promise.resolve([])
        : deps.readDailyTotals(scope, { from, to, groupKind: groupBy }),
      deps.readRunTotals(scope, { from, to }),
      deps.readUnmeteredRuns(scope, { from, to }),
    ]);
    // The workspace's own rows hold every run but the in-app ones, which
    // the assistant row holds (ADR-235).
    const { inApp, rest } = splitInApp(runs);
    const byKey = attribute(rest, groupBy);
    const inAppByKey = attribute(inApp, groupBy);
    const grouped =
      groupBy === "mcp_server"
        ? mcpServerRows(byKey)
        : groupRows(dailyRows).flatMap((row) => {
            const left = withoutInAppShares(
              row,
              dailyRows.filter((day) => day.groupKey === row.key),
              inAppByKey.get(row.key) ?? [],
              byKey.get(row.key) ?? [],
            );
            return left === null ? [] : [left];
          });
    const assistant = assistantRow(inAppByKey);
    // A row of whole runs carries its runs' prompt sources (#5295).
    const wholeRuns = WHOLE_RUN_GROUPINGS.has(groupBy);
    const top = new Map<string, Attributed[]>(
      grouped
        .filter((row) => row.key !== OTHER_SPEND_KEY)
        .map((row): [string, Attributed[]] => [
          row.key,
          [...(byKey.get(row.key) ?? [])]
            .sort(compareShares)
            .slice(0, SPEND_TOP_RUNS_MAX),
        ]),
    );
    // An operator row's key is a principal id, which is a key and not a
    // label. The person it names rides beside it, so the page prints a name.
    const topRunIds = [...top.values()].flatMap((list) =>
      list.map((a) => a.run.runId),
    );
    const topAgentKeys = [...top.values()].flatMap((list) =>
      list.flatMap((a) => (a.run.agentKey === null ? [] : [a.run.agentKey])),
    );
    const [facts, names, harnesses, agentHarnesses] = await Promise.all([
      groupBy === "operator"
        ? (deps.readOperatorFacts ?? noOperatorFacts)(
            scope,
            grouped.map((row) => row.key),
          )
        : new Map<string, never>(),
      deps.readRunNames(scope, topRunIds),
      deps.readRunHarnesses(scope, topRunIds),
      deps.readAgentHarnesses === undefined
        ? new Map<string, string>()
        : deps.readAgentHarnesses(scope, topAgentKeys),
    ]);
    const topRuns = (key: string): SpendTopRun[] =>
      (top.get(key) ?? []).map(({ run, share }) => ({
        runId: run.runId,
        name: names.get(run.runId) ?? null,
        startedAt: run.startedAt.toISOString(),
        agentKey: run.agentKey,
        harness:
          harnesses.get(run.runId) ??
          (run.agentKey === null
            ? null
            : (agentHarnesses.get(run.agentKey) ?? null)),
        operatorKey: run.operatorKey,
        cost: cost(share.micros, run.currency, share.basis),
        calls: share.calls,
      }));
    return {
      period: { from, to },
      groupBy,
      total: sumFigures(runs.map(runFigure)),
      days: spendByDay(runs, from, to),
      reported: reportedSpend(runs),
      observed: observedSpend(runs),
      composition: promptComposition(runs),
      // An open run's row is its running estimate; the page says how many
      // of the period's runs that is. An open run nothing priced adds no
      // figure, so it is no estimate of one.
      estimatedRuns: runs.filter(
        (run) => run.sealedAt === null && run.costMicros !== null,
      ).length,
      // `total.runs` counts these runs and `total.cost` cannot: nothing
      // reported what they spent. The page says how many, and on which
      // harness, wherever it prints the total.
      unmeteredRuns,
      rows: [
        ...grouped.map((row) => ({
          ...row,
          operator: facts.get(row.key) ?? null,
          topRuns: topRuns(row.key),
          ...(wholeRuns
            ? { tokenSources: tokenSourcesOf(runsOf(byKey.get(row.key) ?? [])) }
            : {}),
        })),
        // Last, after the workspace's own ranked rows and the rest, so the
        // assistant never ranks among the people and agents the workspace
        // manages, and the page finds it in one place.
        ...(assistant === null
          ? []
          : [
              wholeRuns
                ? {
                    ...assistant,
                    tokenSources: tokenSourcesOf(
                      runsOf([...inAppByKey.values()].flat()),
                    ),
                  }
                : assistant,
            ]),
      ],
    };
  };
}

export const spendGetHandler = createSpendGetHandler({
  readDailyTotals,
  readRunTotals: (scope, q) =>
    readRunTotals(scope, { ...q, filter: { kind: "all" } }),
  readOperatorFacts,
  readUnmeteredRuns: (scope, q) =>
    readUnmeteredRuns(scope, { ...q, filter: { kind: "all" } }),
  readRunNames,
  readRunHarnesses,
  readAgentHarnesses,
});
