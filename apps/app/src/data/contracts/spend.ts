// The Spend page's view models (ARCHITECTURE.md §3.3, §3.4; #2962), in the
// cost rollup's vocabulary (spec §12, ADR-060). Every money figure is Money in
// micros and every metered one a Cost carrying its basis; a figure no frame
// priced is null and the page prints it as not recorded, never as a zero.
// Proven and accepted spend stay apart (spec §12.8).
import { z } from "zod";
import { PublicId } from "./common";
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

/** Who an operator row names: the person, never the id as a label. */
const OperatorFacts = z.object({
  id: PublicId,
  name: z.string().min(1).nullable(),
  email: z.string().min(1).nullable(),
  avatarUrl: z.string().min(1).nullable(),
  role: z.string().min(1).nullable(),
});
type OperatorFacts = z.infer<typeof OperatorFacts>;

const SpendRow = SpendFigure.extend({
  /** A principal public id, an agent key, a model id or a tool name. */
  key: z.string().min(1),
  /** The model's provider on a model row; null elsewhere. */
  provider: z.string().nullable(),
  /** The person an operator row names; null on every other row. */
  operator: OperatorFacts.nullable(),
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

/** An instant a contract carries as ISO 8601 in UTC. */
const Instant = z.iso.datetime();

/** The span a finding or a list of findings covers. */
const FindingWindow = z.object({ from: Instant, to: Instant });

/** The kinds the findings job detects (ADR-062's detector table). */
const FindingKind = z.enum([
  "cache_writes_never_read",
  "duplicate_tool_calls",
  "repeated_shell_commands",
  "unpaged_results",
]);

/** What a finding is about: a tool, an agent, an operator or the workspace. */
const FindingLevel = z.enum(["tool", "agent", "operator", "workspace"]);

/** The share of the cited calls the counterfactual covers, as the job graded it. */
const FindingConfidence = z.enum(["high", "medium"]);

/**
 * One costed finding (`list_findings`): the saving is the job's figure,
 * measured minus counterfactual over the runs it cites, with the basis those
 * runs were priced on. The page prints it and computes nothing from it but
 * each finding's share of the total (INV-09, INV-10).
 */
export const SpendFinding = z.object({
  id: PublicId,
  kind: FindingKind,
  level: FindingLevel,
  /** The level's key: a tool name, an agent key, an operator's `prn_…` or the workspace id. */
  subject: z.string().min(1),
  saving: Cost,
  confidence: FindingConfidence,
  window: FindingWindow,
  why: z.string().min(1),
  fix: z.string().min(1),
  /** What the finding cites. */
  runs: Count,
  calls: Count,
});
export type SpendFinding = z.infer<typeof SpendFinding>;

/** `list_findings`: the open findings largest saving first, with the totals the page leads with. */
export const SpendFindings = z.object({
  /** The span the listed findings cover; null when none is listed. */
  window: FindingWindow.nullable(),
  saving: Cost.nullable(),
  /** The workspace's priced spend over `window`. */
  spend: Cost.nullable(),
  /** The annualised saving over that spend, annualised the same way. */
  share: z.number().nonnegative().nullable(),
  annualised: Cost.nullable(),
  counts: z.object({
    findings: Count,
    high: Count,
    medium: Count,
    /** Distinct operators whose runs the listed findings cite. */
    operators: Count,
  }),
  findings: z.array(SpendFinding),
});
export type SpendFindings = z.infer<typeof SpendFindings>;

/** `get_finding_evidence`: the arithmetic the job wrote with one finding. */
export const SpendFindingEvidence = z.object({
  finding: SpendFinding,
  calls: Count,
  /** The cited calls the counterfactual prices; the rest add nothing to the saving. */
  coveredCalls: Count,
  measuredTokens: Count,
  counterfactualTokens: Count,
  measured: Money,
  counterfactual: Money,
  /** The cited runs with the largest saving, as the contract ordered them. */
  runs: z.array(
    z.object({
      runId: PublicId,
      startedAt: Instant,
      calls: Count,
      measuredTokens: Count,
      counterfactualTokens: Count,
      measured: Money,
      counterfactual: Money,
    }),
  ),
});
export type SpendFindingEvidence = z.infer<typeof SpendFindingEvidence>;

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

/**
 * The token classes the price book prices (`list_price_entries`), in the order
 * the page reads them: what a call sends, what it reads back out of the cache,
 * what it wrote into one, what it answered, and the classes that are not
 * tokens at all.
 */
export const PriceTokenClass = z.enum([
  "input_uncached",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
  "output",
  "reasoning",
  "server_tool_request",
  "embedding_input",
  "rerank",
  "image",
  "video_second",
]);
export type PriceTokenClass = z.infer<typeof PriceTokenClass>;

/** One rate and its opaque cancellation token for management actions. */
const PriceEntry = z.object({
  cancellationToken: z.string().optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  /** Other names a frame's model id may arrive under, priced by this row. */
  modelAliases: z.array(z.string()),
  /** Null is the region-agnostic row. */
  region: z.string().nullable(),
  tokenClass: PriceTokenClass,
  unit: z.enum(["token", "request", "image", "second"]),
  /** The rate for one million units, as money — the micros the contract carried. */
  ratePerMillion: Money,
  effectiveFrom: Instant,
  /** Null while the row is still in effect. */
  effectiveTo: Instant.nullable(),
  source: z.enum(["list", "negotiated", "override"]),
  /** True where the row is this organization's own, which is what beats the list price. */
  negotiated: z.boolean(),
});
export type PriceEntry = z.infer<typeof PriceEntry>;

/** `list_price_entries`: the book this organization is priced against at `at`. */
export const PriceBook = z.object({
  at: Instant,
  entries: z.array(PriceEntry),
});
export type PriceBook = z.infer<typeof PriceBook>;

/**
 * `list_unpriced_models`: the models the organization has run that the book
 * cannot price. A fully unpriced model's runs carry no cost at all; a partly
 * priced one's are recorded `estimated`. Neither is free, and neither is a zero.
 */
export const UnpricedModels = z.object({
  /** The start of the window the models were observed over. */
  since: Instant,
  /** The instant the book was resolved at. */
  at: Instant,
  models: z.array(
    z.object({
      model: z.string().min(1),
      /** Null where the frames name no vendor. */
      provider: z.string().nullable(),
      calls: Count,
      tokens: Count,
      firstSeen: Instant,
      lastSeen: Instant,
      missingClasses: z.array(PriceTokenClass),
      fullyUnpriced: z.boolean(),
    }),
  ),
});
export type UnpricedModels = z.infer<typeof UnpricedModels>;
