// The priced spend of the model-call frames that ran in a window (spend spec,
// Counting; #4574). Unproductive spend counts claimed frames by the time each
// frame ran (`readUnproductiveClaims` filters on `frame_at`), so the spend it
// is divided by is counted the same way. A run that started before the window
// and ran into it adds only its frames inside the window, and a run that ran
// past the window's end adds only the frames before it.
//
// `cost.run_totals` holds one figure per run. A run whose priced frames all
// fall inside the window adds that figure whole. Every other run that
// overlaps the window has its frames read from the frame store and priced
// one by one, by the rule the rollup prices them with. At most
// `CROSSING_RUNS_PRICED_MAX` such runs are read, largest first. An operator
// whose crossing run was not read, or could not be priced, has no figure, so
// a caller reports no share for it rather than a share of part of its spend.
// A frame store that fails a read leaves the run unpriced and is reported to
// `error_events`: the share is the only figure that needs the read, so the
// figures beside it still answer.
import {
  divideHalfEven,
  loadPriceBookSliceInTenantScope,
  loadRunSource,
  type ModelCallFrame,
  type PriceBook,
  priceFrame,
  runPriceSlice,
} from "@oxagen/billing";
import { schema, withTenantDb } from "@oxagen/database";
import {
  captureError,
  type ModelCallFrameRow,
  readModelCallFrames,
} from "@oxagen/telemetry";
import { and, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";

export type SpendScope = { orgId: string; workspaceId: string };
export type SpendWindow = { start: Date; end: Date };

/** One run that overlaps the window, as `cost.run_totals` holds it. */
export type OverlappingRun = {
  runId: string;
  operatorKey: string | null;
  currency: string;
  costMicros: bigint;
  startedAt: Date;
  /**
   * The latest instant any of the run's priced frames can carry: the seal,
   * or the last rollup when that came first, since a rollup prices only the
   * frames it has seen.
   */
  lastFrameBound: Date;
};

/** One operator's frame-time spend in one currency; `operatorKey` is null for runs that name none. */
export type FrameTimeSpend = {
  operatorKey: string | null;
  currency: string;
  micros: bigint;
};

export type FrameTimeSpendResult = {
  rows: FrameTimeSpend[];
  /** Operators with a run whose frames in the window were not priced; their rows are partial. */
  partial: ReadonlySet<string | null>;
};

export type FrameTimeSpendDeps = {
  /**
   * The priced runs that may hold a frame in the window: started before its
   * end, with a last frame bound at or after its start. `operatorKeys` limits
   * the read to those operators; null reads every run.
   */
  readRuns: (
    scope: SpendScope,
    window: SpendWindow,
    operatorKeys: readonly string[] | null,
  ) => Promise<OverlappingRun[]>;
  /** The cost of the run's frames that ran in the window; null when they cannot be priced. */
  priceRunFrames: (
    scope: SpendScope,
    runId: string,
    window: SpendWindow,
  ) => Promise<bigint | null>;
  /** Records a price read that threw; the run is then left unpriced. */
  reportPriceFailure: (scope: SpendScope, runId: string, err: unknown) => void;
};

/** Runs that cross a window's edge whose frames one read prices. */
export const CROSSING_RUNS_PRICED_MAX = 50;
/** Crossing runs priced at once. */
const PRICE_CONCURRENCY = 8;
/**
 * How long before the window a run may have started and still be read. The
 * findings pass reads runs that started in its trailing 30 days
 * (FINDINGS_WINDOW_DAYS), so no claimed frame belongs to an older run.
 */
export const RUN_LOOKBACK_DAYS = 30;
const DAY_MS = 86_400_000;

/** Whether every priced frame of the run fell inside the window. */
export function insideWindow(run: OverlappingRun, window: SpendWindow): boolean {
  return (
    run.startedAt.getTime() >= window.start.getTime() &&
    run.lastFrameBound.getTime() < window.end.getTime()
  );
}

/**
 * The frame-time spend per operator and currency. Rows come back in no
 * particular order. An operator in `partial` has a row that misses the
 * frames of a crossing run the read could not price.
 */
export async function readFrameTimeSpend(
  deps: FrameTimeSpendDeps,
  scope: SpendScope,
  window: SpendWindow,
  operatorKeys: readonly string[] | null,
): Promise<FrameTimeSpendResult> {
  if (operatorKeys !== null && operatorKeys.length === 0)
    return { rows: [], partial: new Set() };
  const runs = await deps.readRuns(scope, window, operatorKeys);
  const totals = new Map<string, FrameTimeSpend>();
  const add = (run: OverlappingRun, micros: bigint) => {
    const key = `${run.operatorKey ?? ""}\u0000${run.currency}`;
    const held = totals.get(key);
    if (held) held.micros += micros;
    else
      totals.set(key, {
        operatorKey: run.operatorKey,
        currency: run.currency,
        micros,
      });
  };
  const crossing: OverlappingRun[] = [];
  for (const run of runs) {
    if (insideWindow(run, window)) add(run, run.costMicros);
    else crossing.push(run);
  }
  crossing.sort((a, b) =>
    a.costMicros !== b.costMicros
      ? a.costMicros > b.costMicros
        ? -1
        : 1
      : a.runId < b.runId
        ? -1
        : 1,
  );
  const partial = new Set<string | null>();
  for (const run of crossing.slice(CROSSING_RUNS_PRICED_MAX))
    partial.add(run.operatorKey);
  const read = crossing.slice(0, CROSSING_RUNS_PRICED_MAX);
  for (let i = 0; i < read.length; i += PRICE_CONCURRENCY) {
    const batch = read.slice(i, i + PRICE_CONCURRENCY);
    const priced = await Promise.all(
      batch.map((run) =>
        deps.priceRunFrames(scope, run.runId, window).catch((err: unknown) => {
          deps.reportPriceFailure(scope, run.runId, err);
          return null;
        }),
      ),
    );
    batch.forEach((run, j) => {
      const micros = priced[j] ?? null;
      if (micros === null) partial.add(run.operatorKey);
      else add(run, micros);
    });
  }
  return { rows: [...totals.values()], partial };
}

async function readRuns(
  scope: SpendScope,
  window: SpendWindow,
  operatorKeys: readonly string[] | null,
): Promise<OverlappingRun[]> {
  const totals = schema.runTotals;
  const lastFrameBound = sql<Date>`least(coalesce(${totals.sealedAt}, ${totals.rolledUpAt}), ${totals.rolledUpAt})`;
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        runId: totals.runId,
        operatorKey: totals.operatorKey,
        currency: totals.currency,
        micros: sql<string>`${totals.costMicros}::text`,
        startedAt: totals.startedAt,
        lastFrameBound: sql<Date>`${lastFrameBound}`.mapWith(
          totals.rolledUpAt,
        ),
      })
      .from(totals)
      .where(
        and(
          eq(totals.orgId, scope.orgId),
          eq(totals.workspaceId, scope.workspaceId),
          gte(
            totals.startedAt,
            new Date(window.start.getTime() - RUN_LOOKBACK_DAYS * DAY_MS),
          ),
          lt(totals.startedAt, window.end),
          sql`${lastFrameBound} >= ${window.start.toISOString()}::timestamptz`,
          isNotNull(totals.costMicros),
          operatorKeys === null
            ? undefined
            : inArray(totals.operatorKey, [...operatorKeys]),
        ),
      ),
  );
  return rows.map((r) => ({
    runId: r.runId,
    operatorKey: r.operatorKey,
    currency: r.currency,
    costMicros: BigInt(r.micros),
    startedAt: r.startedAt,
    lastFrameBound: r.lastFrameBound,
  }));
}

function toFrame(row: ModelCallFrameRow): ModelCallFrame {
  return {
    at: new Date(row.at),
    model: row.model,
    provider: row.provider,
    tokens: {
      input_uncached: row.inputUncached,
      cache_read: row.cacheRead,
      cache_write_5m: row.cacheWrite5m,
      cache_write_1h: row.cacheWrite1h,
      output: row.output,
      reasoning: row.reasoning,
      server_tool_request: row.serverToolRequests,
    },
    reportedCostMicros:
      row.reportedCostMicros === null ? null : BigInt(row.reportedCostMicros),
    basis: row.basis,
  };
}

/**
 * Price the frames that ran in the window, the way the rollup prices a run:
 * each frame's classes at the book's entry for its model and instant, summed
 * scaled and divided once. A frame the book cannot price adds nothing, as it
 * adds nothing to the run's figure.
 */
export function priceFramesIn(
  orgId: string,
  frames: readonly ModelCallFrame[],
  window: SpendWindow,
  book: PriceBook,
): bigint {
  let scaled = 0n;
  for (const frame of frames) {
    const at = frame.at.getTime();
    if (at < window.start.getTime() || at >= window.end.getTime()) continue;
    const priced = priceFrame(book, orgId, frame);
    if (priced.scaled !== null) scaled += priced.scaled;
  }
  return divideHalfEven(scaled, 1_000_000n);
}

async function priceRunFrames(
  scope: SpendScope,
  runId: string,
  window: SpendWindow,
): Promise<bigint | null> {
  // loadRunSource finds the run by its public id on the system connection,
  // as the rollup does. The run id came from this workspace's own
  // run_totals rows, and the check below refuses a source from any other.
  const source = await loadRunSource(runId);
  if (
    source === null ||
    source.meta.orgId !== scope.orgId ||
    source.meta.workspaceId !== scope.workspaceId
  )
    return null;
  const rows = await readModelCallFrames({ ...scope, run: source.frames });
  const frames = rows
    .map(toFrame)
    .filter(
      (f) =>
        f.at.getTime() >= window.start.getTime() &&
        f.at.getTime() < window.end.getTime(),
    );
  if (frames.length === 0) return 0n;
  const book = await loadPriceBookSliceInTenantScope(
    runPriceSlice(scope.orgId, frames),
  );
  return priceFramesIn(scope.orgId, frames, window, book);
}

function reportPriceFailure(
  scope: SpendScope,
  runId: string,
  err: unknown,
): void {
  captureError({
    error: err,
    source: "api",
    severity: "warn",
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    context: `frame-time spend: run ${runId} left unpriced`,
  });
}

export const frameTimeSpendDeps: FrameTimeSpendDeps = {
  readRuns,
  priceRunFrames,
  reportPriceFailure,
};
