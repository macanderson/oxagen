// The Spend page's view models (ARCHITECTURE.md §3.3, §3.4; #2962), in the
// cost rollup's vocabulary (spec §12, ADR-060). Every money figure is Money in
// micros and every metered one a Cost carrying its basis; a figure no frame
// priced is null and the page prints it as not recorded, never as a zero.
// Proven and accepted spend stay apart (spec §12.8).
import { z } from "zod";
import { Cost, Money } from "./money";

const Count = z.number().int().nonnegative();
const Ratio = z.number().min(0).max(1);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A run's public id (`arun_…` for a ledger run, `tse_…` for a wrapped one). */
const RunPublicId = z.string().regex(/^(arun|tse)_[0-9a-z]+$/);

/** An inclusive range of UTC days. */
export const DayRange = z.object({ from: Day, to: Day });
export type DayRange = z.infer<typeof DayRange>;

/** The levels the page reads the rollup at. */
export const SpendGroupKind = z.enum(["operator", "agent", "model", "tool"]);
export type SpendGroupKind = z.infer<typeof SpendGroupKind>;

/** The levels a drill opens (spec §12.9): a model has none. */
export const SpendDrillKind = z.enum(["operator", "agent", "tool"]);
export type SpendDrillKind = z.infer<typeof SpendDrillKind>;

const SpendFigure = z.object({
  cost: Cost.nullable(),
  calls: Count,
  runs: Count,
  proven: Money.nullable(),
  accepted: Money.nullable(),
  productiveRatio: Ratio.nullable(),
});
export type SpendFigure = z.infer<typeof SpendFigure>;

const SpendRow = SpendFigure.extend({
  /** A principal public id, an agent key, a model id or a tool name. */
  key: z.string().min(1),
  /** The model's provider on a model row; null elsewhere. */
  provider: z.string().nullable(),
});

/** `get_spend` at one level: the period total and its groups, largest spend first. */
export const SpendReport = z.object({
  period: DayRange,
  total: SpendFigure,
  rows: z.array(SpendRow),
});
export type SpendReport = z.infer<typeof SpendReport>;

/**
 * Fleet's two spend tiles: `get_spend` at the model level over one day. The
 * cache hit rate is cache_read ÷ (input_uncached + cache_read) over the day's
 * model calls, null when they read no input token.
 */
export const FleetSpend = z.object({
  period: DayRange,
  spend: Cost.nullable(),
  cacheHitRate: Ratio.nullable(),
});
export type FleetSpend = z.infer<typeof FleetSpend>;

/** `get_spend_drill`: one operator, agent or tool over its trailing window. */
export const SpendDrill = z.object({
  kind: SpendDrillKind,
  key: z.string().min(1),
  period: DayRange,
  total: SpendFigure,
  /** One entry per day of the window, oldest first. */
  series: z.array(
    z.object({ day: Day, cost: Cost.nullable(), calls: Count, runs: Count }),
  ),
  perCall: Money.nullable(),
  perRun: Money.nullable(),
  /** The key's share of the workspace's spend over the window. */
  share: Ratio.nullable(),
  tools: z.array(
    z.object({ name: z.string().min(1), calls: Count, runs: Count }),
  ),
});
export type SpendDrill = z.infer<typeof SpendDrill>;

/** `list_waste`: spend the frames show bought nothing, by cause. */
export const SpendWaste = z.object({
  wasted: Cost.nullable(),
  share: Ratio.nullable(),
  runsWithWaste: Count,
  largestCause: z.enum(["cache_write_never_read"]).nullable(),
  causes: z.array(
    z.object({
      cause: z.enum(["cache_write_never_read"]),
      wasted: Cost,
      runs: Count,
      /** The runs that prove the cause, largest waste first. */
      provingRuns: z.array(RunPublicId),
    }),
  ),
});
export type SpendWaste = z.infer<typeof SpendWaste>;

/** `get_spend_budget`: each configured ceiling in the active scope with its burn. */
export const SpendBudgets = z.array(
  z.object({
    scope: z.enum(["org", "workspace"]),
    enabled: z.boolean(),
    period: z.enum(["monthly", "rolling"]),
    windowDays: z.number().int().positive().nullable(),
    limit: Money.nullable(),
    spent: Money,
    /** spent ÷ limit; meaningful only where a limit is set. */
    ratio: z.number().nonnegative(),
    state: z.enum([
      "ok",
      "threshold_50",
      "threshold_80",
      "threshold_95",
      "exceeded",
    ]),
  }),
);
export type SpendBudgets = z.infer<typeof SpendBudgets>;
