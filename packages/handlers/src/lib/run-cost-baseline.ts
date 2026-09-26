// The agent baseline `get_run_cost` answers beside a run (#3984, ADR-192):
// the agent's own sealed runs in the 30 days before this run started, this
// run left out, as a median cost and a step-weighted productive ratio.
//
// The window ends at the run's start, not at now, so a sealed run's delta
// against its baseline does not drift as the agent keeps running. A run that
// is still open is left out: its cost is a running estimate (#3980) and its
// steps are not all graded yet. The ratio is sum(advanced) over sum(steps)
// across the graded runs, so a long run weighs as many steps as it took,
// never as one run's ratio among many.
//
// Postgres folds the window into one row, so the read costs the same for an
// agent with five runs and one with fifty thousand. `baselineOf` applies the
// minimums and the rounding, and is what the tests exercise without a
// database.
import { type CostBasis, foldBasis } from "@oxagen/billing";
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import {
  RUN_COST_BASELINE_MIN_RUNS,
  type RunCostBaseline,
} from "@oxagen/oxagen/contracts/run.cost";
import { costBasisSchema } from "@oxagen/oxagen/contracts/spend.shared";
import { and, eq, gte, isNotNull, lt, ne, sql } from "drizzle-orm";

/** How far back the window reaches from the run's start. */
export const BASELINE_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;
const totals = schema.runTotals;

type BaselineScope = { orgId: string; workspaceId: string };

/** The run a baseline is read for: what its own `cost.run_totals` row names. */
export interface BaselineRun {
  runId: string;
  agentKey: string | null;
  startedAt: Date;
  currency: string;
}

/** The window folded to one row, as Postgres answers it. */
export interface BaselineAggregate {
  /** Sealed runs in the window. */
  runs: number;
  /** Of those, the runs with a cost in the run's currency. */
  priced: number;
  /** `percentile_cont(0.5)` of those costs, in micros; null with none. */
  medianMicros: number | null;
  /** The distinct bases of the priced runs. */
  bases: readonly string[];
  /** Of the sealed runs, the ones whose steps are graded. */
  graded: number;
  /** Advanced steps and all steps over the graded runs. */
  advancedSteps: number;
  gradedSteps: number;
}

type QueryDb = Pick<Tx, "select">;

/**
 * The window's one-row fold. Exported so a test can read the SQL it renders:
 * the predicates are the rule, and a test that fakes the answer cannot see
 * them.
 */
export function baselineQuery(
  db: QueryDb,
  scope: BaselineScope,
  run: BaselineRun & { agentKey: string },
) {
  const from = new Date(run.startedAt.getTime() - BASELINE_WINDOW_DAYS * DAY_MS);
  const priced = sql`${totals.costMicros} is not null and ${totals.currency} = ${run.currency}`;
  const graded = sql`${totals.advancedSteps} is not null`;
  return db
    .select({
      runs: sql<number>`count(*)::int`.mapWith(Number),
      priced: sql<number>`(count(*) filter (where ${priced}))::int`.mapWith(
        Number,
      ),
      // float8 carries every micro-USD figure a run can reach exactly; the
      // median of an even count may end in .5, which baselineOf rounds.
      medianMicros: sql<
        string | null
      >`(percentile_cont(0.5) within group (order by ${totals.costMicros}) filter (where ${priced}))::text`,
      bases: sql<
        string[] | null
      >`array_agg(distinct ${totals.costBasis}) filter (where ${priced})`,
      graded: sql<number>`(count(*) filter (where ${graded}))::int`.mapWith(
        Number,
      ),
      advancedSteps: sql<string | null>`(sum(${totals.advancedSteps}) filter (where ${graded}))::text`,
      gradedSteps: sql<string | null>`(sum(${totals.steps}) filter (where ${graded}))::text`,
    })
    .from(totals)
    .where(
      and(
        eq(totals.orgId, scope.orgId),
        eq(totals.workspaceId, scope.workspaceId),
        eq(totals.agentKey, run.agentKey),
        isNotNull(totals.sealedAt),
        gte(totals.startedAt, from),
        lt(totals.startedAt, run.startedAt),
        ne(totals.runId, run.runId),
      ),
    );
}

/** A float micro figure to whole micros, a half rounded to the even neighbour. */
export function microsHalfEven(value: number): bigint {
  const floor = Math.floor(value);
  const rest = value - floor;
  if (rest > 0.5) return BigInt(floor + 1);
  if (rest < 0.5) return BigInt(floor);
  return BigInt(floor % 2 === 0 ? floor : floor + 1);
}

/**
 * The contract's baseline from the window's fold. Null when fewer than
 * RUN_COST_BASELINE_MIN_RUNS sealed runs fall in the window. Each figure is
 * null on its own when fewer than that many runs carry it: a median of four
 * priced runs is not a baseline, whatever the other runs were.
 */
export function baselineOf(
  run: Pick<BaselineRun, "startedAt" | "currency">,
  agg: BaselineAggregate,
): RunCostBaseline | null {
  if (agg.runs < RUN_COST_BASELINE_MIN_RUNS) return null;
  let basis: CostBasis | null = null;
  for (const b of agg.bases) {
    const parsed = costBasisSchema.safeParse(b);
    if (parsed.success) basis = foldBasis(basis, parsed.data);
  }
  const medianCost =
    agg.priced < RUN_COST_BASELINE_MIN_RUNS ||
    agg.medianMicros === null ||
    basis === null
      ? null
      : {
          micros: microsHalfEven(agg.medianMicros).toString(),
          currency: run.currency,
          basis,
        };
  const productiveRatio =
    agg.graded < RUN_COST_BASELINE_MIN_RUNS || agg.gradedSteps <= 0
      ? null
      : agg.advancedSteps / agg.gradedSteps;
  return {
    windowDays: BASELINE_WINDOW_DAYS,
    before: run.startedAt.toISOString(),
    runs: agg.runs,
    medianCost,
    productiveRatio,
  };
}

type AggregateRow = {
  runs: number;
  priced: number;
  medianMicros: string | null;
  bases: string[] | null;
  graded: number;
  advancedSteps: string | null;
  gradedSteps: string | null;
};

/** A numeric Postgres answered as text; null when it answered none. */
function numberOf(value: string | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** The fold as numbers; an empty window answers zeros and nulls. */
export function aggregateOf(row: AggregateRow | undefined): BaselineAggregate {
  return {
    runs: row?.runs ?? 0,
    priced: row?.priced ?? 0,
    medianMicros: numberOf(row?.medianMicros),
    bases: row?.bases ?? [],
    graded: row?.graded ?? 0,
    advancedSteps: numberOf(row?.advancedSteps) ?? 0,
    gradedSteps: numberOf(row?.gradedSteps) ?? 0,
  };
}

/**
 * The agent's baseline for one run, read inside the caller's tenant scope.
 * Null for a run that names no agent, and for an agent with too few sealed
 * runs in the window.
 */
export async function readRunCostBaseline(
  scope: BaselineScope,
  run: BaselineRun,
): Promise<RunCostBaseline | null> {
  const { agentKey } = run;
  if (agentKey === null) return null;
  const rows = await withTenantDb((tx) =>
    baselineQuery(tx, scope, { ...run, agentKey }),
  );
  return baselineOf(run, aggregateOf(rows[0]));
}
