// The priced spend of the model-call frames that ran in a window (spend spec,
// Counting; #4574). Unproductive spend counts claimed frames by the time each
// frame ran (`readUnproductiveClaims` filters on `frame_at`), so the spend it
// is divided by is counted the same way. A run that started before the window
// and ran into it adds only its frames inside the window, and a run that ran
// past the window's end adds only the frames before it.
//
// `cost.run_totals` holds one figure per run. The runs whose priced frames all
// fall inside the window are summed in Postgres, per operator and currency.
// Every other run that overlaps the window is listed, and its frames are read
// from the frame store and priced one by one, by the rule the rollup prices
// them with. At most `CROSSING_RUNS_PRICED_MAX` such runs are read, largest
// first. An operator whose crossing run was not read, or could not be priced,
// has no figure, so a caller reports no share for it rather than a share of
// part of its spend. A frame store that fails a read leaves the run unpriced
// and is reported to `error_events`: the share is the only figure that needs
// the read, so the figures beside it still answer.
//
// A run's last priced frame is bounded by its seal, or by its last rollup
// when that came first. An unsealed run's bound is its last rollup, so a
// price-book rebuild that rolls old unsealed runs up again makes each of them
// a crossing run until it seals. Past the cap, the shares that need them read
// null for the period.
import {
  divideHalfEven,
  loadPriceBookSliceInTenantScope,
  type ModelCallFrame,
  type PriceBook,
  priceFrame,
  runPriceSlice,
} from "@oxagen/billing";
import { schema, withTenantDb } from "@oxagen/database";
import { subagentSessionsQuery } from "@oxagen/run-ledger";
import {
  captureError,
  type FrameRunRef,
  type ModelCallFrameRow,
  readModelCallFrames,
} from "@oxagen/telemetry";
import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

export type SpendScope = { orgId: string; workspaceId: string };
export type SpendWindow = { start: Date; end: Date };

/** One operator's frame-time spend in one currency; `operatorKey` is null for runs that name none. */
export type FrameTimeSpend = {
  operatorKey: string | null;
  currency: string;
  micros: bigint;
};

/** A priced run that holds frames on both sides of a window's edge, or may. */
export type CrossingRun = {
  runId: string;
  operatorKey: string | null;
  currency: string;
  /** The run's whole priced cost; it orders the runs the cap reads. */
  costMicros: bigint;
};

export type FrameTimeSpendResult = {
  rows: FrameTimeSpend[];
  /** Operators with a run whose frames in the window were not priced; their rows are partial. */
  partial: ReadonlySet<string | null>;
};

export type FrameTimeSpendDeps = {
  /**
   * The priced runs that may hold a frame in the window. `contained` sums the
   * runs whose every priced frame falls inside it, per operator and currency.
   * `crossing` lists the rest: started before the window, or with a last
   * frame bound at or past its end. `operatorKeys` limits both to those
   * operators; null reads every run.
   */
  readRuns: (
    scope: SpendScope,
    window: SpendWindow,
    operatorKeys: readonly string[] | null,
  ) => Promise<{ contained: FrameTimeSpend[]; crossing: CrossingRun[] }>;
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
  const { contained, crossing } = await deps.readRuns(
    scope,
    window,
    operatorKeys,
  );
  const totals = new Map<string, FrameTimeSpend>();
  const add = (
    row: { operatorKey: string | null; currency: string },
    micros: bigint,
  ) => {
    const key = `${row.operatorKey ?? ""}\u0000${row.currency}`;
    const held = totals.get(key);
    if (held) held.micros += micros;
    else
      totals.set(key, {
        operatorKey: row.operatorKey,
        currency: row.currency,
        micros,
      });
  };
  for (const row of contained) add(row, row.micros);
  const ordered = [...crossing].sort((a, b) =>
    a.costMicros !== b.costMicros
      ? a.costMicros > b.costMicros
        ? -1
        : 1
      : a.runId < b.runId
        ? -1
        : 1,
  );
  const partial = new Set<string | null>();
  for (const run of ordered.slice(CROSSING_RUNS_PRICED_MAX))
    partial.add(run.operatorKey);
  const read = ordered.slice(0, CROSSING_RUNS_PRICED_MAX);
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
): Promise<{ contained: FrameTimeSpend[]; crossing: CrossingRun[] }> {
  const totals = schema.runTotals;
  // The latest instant a priced frame of the run can carry: a rollup prices
  // only the frames it has seen, and a sealed run has no frame past its seal.
  const lastFrameBound = sql`least(coalesce(${totals.sealedAt}, ${totals.rolledUpAt}), ${totals.rolledUpAt})`;
  const start = window.start.toISOString();
  const end = window.end.toISOString();
  const overlaps: (SQL | undefined)[] = [
    eq(totals.orgId, scope.orgId),
    eq(totals.workspaceId, scope.workspaceId),
    gte(
      totals.startedAt,
      new Date(window.start.getTime() - RUN_LOOKBACK_DAYS * DAY_MS),
    ),
    lt(totals.startedAt, window.end),
    sql`${lastFrameBound} >= ${start}::timestamptz`,
    isNotNull(totals.costMicros),
    operatorKeys === null
      ? undefined
      : inArray(totals.operatorKey, [...operatorKeys]),
  ];
  const { contained, crossing } = await withTenantDb(async (tx) => {
    const containedRows = await tx
      .select({
        operatorKey: totals.operatorKey,
        currency: totals.currency,
        micros: sql<string>`sum(${totals.costMicros})::text`,
      })
      .from(totals)
      .where(
        and(
          ...overlaps,
          gte(totals.startedAt, window.start),
          sql`${lastFrameBound} < ${end}::timestamptz`,
        ),
      )
      .groupBy(totals.operatorKey, totals.currency);
    const crossingRows = await tx
      .select({
        runId: totals.runId,
        operatorKey: totals.operatorKey,
        currency: totals.currency,
        micros: sql<string>`${totals.costMicros}::text`,
      })
      .from(totals)
      .where(
        and(
          ...overlaps,
          or(
            lt(totals.startedAt, window.start),
            sql`${lastFrameBound} >= ${end}::timestamptz`,
          ),
        ),
      );
    return { contained: containedRows, crossing: crossingRows };
  });
  return {
    contained: contained.map((r) => ({
      operatorKey: r.operatorKey,
      currency: r.currency,
      micros: BigInt(r.micros),
    })),
    crossing: crossing.map((r) => ({
      runId: r.runId,
      operatorKey: r.operatorKey,
      currency: r.currency,
      costMicros: BigInt(r.micros),
    })),
  };
}

/**
 * Where the run's frames live, read in the caller's tenant scope: a ledger
 * run by its uuid and the message that asked for it, a wrapped run by its
 * root session and every subagent chain under it. These are the refs the
 * rollup reads the run's frames by (`loadRunSource`), without its system
 * connection. Null when the workspace holds no such run.
 */
async function readRunRef(
  scope: SpendScope,
  runId: string,
): Promise<FrameRunRef | null> {
  return withTenantDb(async (tx): Promise<FrameRunRef | null> => {
    if (runId.startsWith("arun_")) {
      const runs = schema.agentRuns;
      const [row] = await tx
        .select({ id: runs.id, originMessageId: runs.originMessageId })
        .from(runs)
        .where(
          and(
            eq(runs.orgId, scope.orgId),
            eq(runs.workspaceId, scope.workspaceId),
            eq(runs.publicId, runId),
          ),
        )
        .limit(1);
      return row
        ? {
            kind: "ledger",
            runUuid: row.id,
            originMessageId: row.originMessageId,
          }
        : null;
    }
    if (runId.startsWith("tse_")) {
      const sessions = schema.tachoSessions;
      const [root] = await tx
        .select({ sessionUuid: sessions.sessionUuid })
        .from(sessions)
        .where(
          and(
            eq(sessions.orgId, scope.orgId),
            eq(sessions.workspaceId, scope.workspaceId),
            eq(sessions.publicId, runId),
            isNull(sessions.parentSessionUuid),
          ),
        )
        .limit(1);
      if (!root) return null;
      const children = await subagentSessionsQuery(
        tx,
        scope,
        root.sessionUuid,
      );
      return {
        kind: "tacho",
        rootSessionUuid: root.sessionUuid,
        sessionUuids: [
          root.sessionUuid,
          ...children.map((child) => child.sessionUuid),
        ],
      };
    }
    return null;
  });
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
  const ref = await readRunRef(scope, runId);
  if (ref === null) return null;
  const rows = await readModelCallFrames({ ...scope, run: ref });
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

/** The production reads; exported for the Postgres test that runs their SQL. */
export const frameTimeSpendDeps: FrameTimeSpendDeps = {
  readRuns,
  priceRunFrames,
  reportPriceFailure,
};
