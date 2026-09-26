// spend.shared.ts — what the spend handlers share: the Postgres reads over the
// derived rollups (`cost.daily_totals`, `cost.run_totals`) and the mapping
// from a rollup figure to the contract's money shape (ADR-060).
//
// The handlers read Postgres only. The kernel enters the tenant scope before
// a handler runs, so every read goes through withTenantDb, whose RLS is the
// tenant filter; the queries also name org_id and workspace_id, since a local
// stack runs with the RLS bypass on and another workspace's rows must still
// stay out. Money on the wire is micros as a decimal string with a currency
// and, for a metered figure, the basis the rollup recorded (INV-09, INV-10);
// a figure no frame priced is null, never a zero.
import type {
  Cost,
  SpendFigure,
  TokenCounts,
} from "@oxagen/oxagen/contracts/spend.shared";
import { schema, withTenantDb } from "@oxagen/database";
import {
  dayBounds,
  foldBasis,
  runTotalsRowToRecord,
  utcDay,
  type CostBasis,
  type DailyTotalsRecord,
  type RunTotalsRecord,
  type SpendGroupKind,
  ZERO_TOKENS,
} from "@oxagen/billing";
import { and, asc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";

export type SpendScope = { orgId: string; workspaceId: string };

const daily = schema.dailyTotals;
const totals = schema.runTotals;

// ── Money ─────────────────────────────────────────────────────────────────────

export function money(micros: bigint, currency: string) {
  return { micros: micros.toString(), currency };
}

/** A metered cost, or null when the rollup priced nothing. */
export function cost(
  micros: bigint | null,
  currency: string,
  basis: CostBasis | null,
): Cost | null {
  if (micros === null || basis === null) return null;
  return { micros: micros.toString(), currency, basis };
}

/** The figure fields every rollup row carries, summed. */
interface FigureSource {
  costMicros: bigint | null;
  costBasis: CostBasis | null;
  currency: string;
  calls: number;
  runs: number;
  provenMicros: bigint | null;
  acceptedMicros: bigint | null;
  productiveRatio: number | null;
  /**
   * The graded steps behind `productiveRatio`, its weight in a sum. Null on
   * a daily row rolled up before the weight was stored; that row weighs as
   * its run count.
   */
  gradedSteps: number | null;
}

/** Sum figures into one; a null stays null unless some source carries a value. */
export function sumFigures(sources: readonly FigureSource[]): SpendFigure {
  let micros: bigint | null = null;
  const bases: CostBasis[] = [];
  let calls = 0;
  let runs = 0;
  let proven: bigint | null = null;
  let accepted: bigint | null = null;
  let ratioSum = 0;
  let ratioWeight = 0;
  let currency = "USD";
  for (const s of sources) {
    currency = s.currency;
    calls += s.calls;
    runs += s.runs;
    if (s.costMicros !== null && s.costBasis !== null) {
      micros = micros === null ? s.costMicros : micros + s.costMicros;
      bases.push(s.costBasis);
    }
    if (s.provenMicros !== null)
      proven = proven === null ? s.provenMicros : proven + s.provenMicros;
    if (s.acceptedMicros !== null)
      accepted =
        accepted === null ? s.acceptedMicros : accepted + s.acceptedMicros;
    if (s.productiveRatio !== null) {
      // Weighted by graded steps, so the sum is advanced steps over steps,
      // the division the agent baseline makes (ADR-199). A row with no
      // stored weight weighs as its run count.
      const weight = s.gradedSteps ?? Math.max(1, s.runs);
      ratioSum += s.productiveRatio * weight;
      ratioWeight += weight;
    }
  }
  return {
    cost: cost(
      micros,
      currency,
      bases.reduce<CostBasis | null>(foldBasis, null),
    ),
    calls,
    runs,
    proven: proven === null ? null : money(proven, currency),
    accepted: accepted === null ? null : money(accepted, currency),
    productiveRatio: ratioWeight === 0 ? null : ratioSum / ratioWeight,
  };
}

export function addTokens(into: TokenCounts, from: TokenCounts): TokenCounts {
  return {
    input_uncached: into.input_uncached + from.input_uncached,
    cache_read: into.cache_read + from.cache_read,
    cache_write_5m: into.cache_write_5m + from.cache_write_5m,
    cache_write_1h: into.cache_write_1h + from.cache_write_1h,
    output: into.output + from.output,
    reasoning: into.reasoning + from.reasoning,
  };
}

export { ZERO_TOKENS };

/** The figure a run row is, for the sums above. */
export function runFigure(run: RunTotalsRecord): FigureSource {
  return {
    costMicros: run.costMicros,
    costBasis: run.costBasis,
    currency: run.currency,
    calls: run.steps,
    runs: 1,
    // A verdict makes the proven figure exist; only a priced, flipped run
    // adds to it. The same for a human's acceptance (spec §12.8).
    provenMicros:
      run.verdict === null
        ? null
        : run.verdict === "flipped" && run.costMicros !== null
          ? run.costMicros
          : 0n,
    acceptedMicros:
      run.accepted === null
        ? null
        : run.accepted && run.costMicros !== null
          ? run.costMicros
          : 0n,
    productiveRatio: run.productiveRatio,
    gradedSteps: run.advancedSteps === null ? null : run.steps,
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** The daily group rows of one level over an inclusive day range. */
export async function readDailyTotals(
  scope: SpendScope,
  q: { from: string; to: string; groupKind: SpendGroupKind },
): Promise<DailyTotalsRecord[]> {
  const rows = await withTenantDb((tx) =>
    tx
      .select()
      .from(daily)
      .where(
        and(
          eq(daily.orgId, scope.orgId),
          eq(daily.workspaceId, scope.workspaceId),
          eq(daily.groupKind, q.groupKind),
          gte(daily.day, q.from),
          lte(daily.day, q.to),
        ),
      )
      .orderBy(asc(daily.day)),
  );
  return rows.map((r) => ({
    orgId: r.orgId,
    workspaceId: r.workspaceId,
    day: r.day,
    groupKind: r.groupKind as SpendGroupKind,
    groupKey: r.groupKey,
    provider: r.provider,
    runs: r.runs,
    calls: r.calls,
    costMicros: r.costMicros,
    currency: r.currency,
    costBasis: r.costBasis as CostBasis | null,
    provenMicros: r.provenMicros,
    acceptedMicros: r.acceptedMicros,
    productiveRatio:
      r.productiveRatio === null ? null : Number(r.productiveRatio),
    gradedSteps: r.gradedSteps,
    tokens: r.tokens as TokenCounts,
  }));
}

/** Which run rows a read wants: every run in the window, or one key's. */
export type RunFilter =
  | { kind: "all" }
  | { kind: "operator"; key: string }
  | { kind: "agent"; key: string }
  | { kind: "tool"; key: string };

function runFilterPredicate(filter: RunFilter) {
  switch (filter.kind) {
    case "all":
      return undefined;
    case "operator":
      return eq(totals.operatorKey, filter.key);
    case "agent":
      return eq(totals.agentKey, filter.key);
    case "tool":
      return sql`${totals.breakdown}->'tools' @> ${JSON.stringify([{ name: filter.key }])}::jsonb`;
  }
}

/** The run rows that started in an inclusive day range, oldest first. */
export async function readRunTotals(
  scope: SpendScope,
  q: { from: string; to: string; filter: RunFilter },
): Promise<RunTotalsRecord[]> {
  const { start } = dayBounds(q.from);
  const { next } = dayBounds(q.to);
  const rows = await withTenantDb((tx) =>
    tx
      .select()
      .from(totals)
      .where(
        and(
          eq(totals.orgId, scope.orgId),
          eq(totals.workspaceId, scope.workspaceId),
          gte(totals.startedAt, start),
          lt(totals.startedAt, next),
          runFilterPredicate(q.filter),
        ),
      )
      .orderBy(asc(totals.startedAt)),
  );
  return rows.map(runTotalsRowToRecord);
}

/** The run rows for a set of public ids, keyed by id; a run with no row is absent. */
export async function readRunTotalsByIds(
  scope: SpendScope,
  runIds: readonly string[],
): Promise<Map<string, RunTotalsRecord & { rolledUpAt: Date }>> {
  if (runIds.length === 0) return new Map();
  const rows = await withTenantDb((tx) =>
    tx
      .select()
      .from(totals)
      .where(
        and(
          eq(totals.orgId, scope.orgId),
          eq(totals.workspaceId, scope.workspaceId),
          inArray(totals.runId, [...runIds]),
        ),
      ),
  );
  return new Map(
    rows.map((r) => [
      r.runId,
      { ...runTotalsRowToRecord(r), rolledUpAt: r.rolledUpAt },
    ]),
  );
}

/** Every day from `from` to `to` inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let at = dayBounds(from).start;
  const end = dayBounds(to).start;
  while (at.getTime() <= end.getTime()) {
    out.push(utcDay(at));
    at = new Date(at.getTime() + 24 * 60 * 60 * 1000);
  }
  return out;
}
