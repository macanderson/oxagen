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
  UnmeteredRuns,
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
import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";

export type SpendScope = { orgId: string; workspaceId: string };

const daily = schema.dailyTotals;
const totals = schema.runTotals;
const sessions = schema.tachoSessions;

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
      // Weighted by runs so a group of many runs outweighs one.
      ratioSum += s.productiveRatio * Math.max(1, s.runs);
      ratioWeight += Math.max(1, s.runs);
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
    server_tool_request: into.server_tool_request + from.server_tool_request,
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
    // A row rolled up before `server_tool_request` existed has no key for it.
    // The rollup counted none then, so it reads as 0.
    tokens: { ...ZERO_TOKENS, ...(r.tokens as Partial<TokenCounts>) },
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

/**
 * The wrapped runs in an inclusive day range whose rollup found no model
 * call, by the harness that ran them (#3304). Every spend total leaves their
 * cost out, because no frame reported what they spent: a harness whose model
 * calls do not pass through the Oxagen gateway or the local proxy (Cursor,
 * Stella on a provider other than Anthropic, a Codex or Stella session with
 * its own base URL) records tool calls and no usage. The count is what lets
 * a page say so instead of printing a total that reads complete.
 *
 * A run is counted when its `cost.run_totals` row holds no model call and the
 * run has either sealed or made a tool call. An open run that has done
 * neither is left out: `cost.run-progress` writes a row on a run's first
 * batch, before its first model call can land, so for a moment every new run
 * holds none. A run that has not been rolled up yet has no row, and a ledger
 * run meters every call through the gateway, so neither is counted. `filter`
 * is the same one {@link readRunTotals} takes, so a drill counts the runs its
 * own total covers. A session row that names no harness is grouped as
 * `unknown`.
 */
export async function readUnmeteredRuns(
  scope: SpendScope,
  q: { from: string; to: string; filter: RunFilter },
): Promise<UnmeteredRuns> {
  const { start } = dayBounds(q.from);
  const { next } = dayBounds(q.to);
  const harness = sql<string>`coalesce(${sessions.harness}, 'unknown')`;
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        harness,
        runs: sql<number>`count(*)::int`.mapWith(Number),
      })
      .from(totals)
      .leftJoin(
        sessions,
        and(
          eq(sessions.publicId, totals.runId),
          eq(sessions.orgId, totals.orgId),
          eq(sessions.workspaceId, totals.workspaceId),
        ),
      )
      .where(
        and(
          eq(totals.orgId, scope.orgId),
          eq(totals.workspaceId, scope.workspaceId),
          eq(totals.runSource, "tacho"),
          eq(totals.modelCalls, 0),
          or(isNotNull(totals.sealedAt), gt(totals.toolCalls, 0)),
          gte(totals.startedAt, start),
          lt(totals.startedAt, next),
          runFilterPredicate(q.filter),
        ),
      )
      .groupBy(harness),
  );
  return unmeteredRunsOf(rows);
}

/** Harness counts as the contract carries them: most runs first, then by name. */
function unmeteredRunsOf(
  rows: readonly { harness: string; runs: number }[],
): UnmeteredRuns {
  const byHarness = rows
    .filter((row) => row.runs > 0)
    .map((row) => ({ harness: row.harness, runs: row.runs }))
    .sort(
      (a, b) =>
        b.runs - a.runs ||
        (a.harness < b.harness ? -1 : a.harness > b.harness ? 1 : 0),
    );
  return {
    total: byHarness.reduce((sum, row) => sum + row.runs, 0),
    byHarness,
  };
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
