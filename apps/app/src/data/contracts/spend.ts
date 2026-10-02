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
/**
 * A run's public id (`arun_…` for a ledger run, `tse_…` for a wrapped one).
 * Fields narrow `PublicId` with it rather than alias it, so INV-11
 * (`src/test/arch/public-ids.test.ts`) still reads each one as a PublicId.
 */
const RUN_PUBLIC_ID = /^(arun|tse)_[0-9a-z]+$/;

/** An inclusive range of UTC days. */
export const DayRange = z.object({ from: Day, to: Day });
export type DayRange = z.infer<typeof DayRange>;

/** The levels the page reads the rollup at. */
export const SpendGroupKind = z.enum([
  "operator",
  "agent",
  "model",
  "tool",
  "task",
  "cost_center",
  "mcp_server",
]);
export type SpendGroupKind = z.infer<typeof SpendGroupKind>;

/**
 * The key of the `cost_center` row that holds spend no cost center claims
 * (ADR-142). The label pattern refuses `~`, so no label collides with it.
 */
export const UNASSIGNED_COST_CENTER_KEY = "~none";

/**
 * The key of the `mcp_server` row that holds the spend no MCP server's tool
 * results carried. A server name has no `~`, so no server collides with it.
 */
export const OTHER_SPEND_KEY = "~other";

/**
 * The key of the row that holds the in-app assistant's spend, in every
 * grouping. Oxagen runs the assistant, and the workspace does not monitor it
 * (ADR-235), so the row lists no runs and opens no drill. No other key starts
 * with `~`, so none collides with it.
 */
export const ASSISTANT_SPEND_KEY = "~oxagen_assistant";

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

/** Normalized token classes already returned by get_spend. */
const SpendTokens = z.object({
  input_uncached: Count,
  cache_read: Count,
  cache_write_5m: Count,
  cache_write_1h: Count,
  output: Count,
  reasoning: Count,
  /**
   * Web search requests, which the book prices per request (#3721). Not
   * tokens, so no token total or share counts them. Absent from a view
   * built before the rollup recorded them.
   */
  server_tool_request: Count.optional(),
});

/** One of a row's costliest runs, with the row's part of its cost. */
const SpendTopRun = z.object({
  runId: PublicId.regex(RUN_PUBLIC_ID),
  /** The session name the Fleet board shows; null when the run has none. */
  name: z.string().nullable(),
  startedAt: z.iso.datetime({ offset: true }),
  agentKey: z.string().nullable(),
  harness: z.string().nullable().optional(),
  /** The operator's principal public id; null for a run with no operator. */
  operatorKey: z.string().nullable(),
  cost: Cost.nullable(),
  calls: Count,
});
export type SpendTopRun = z.infer<typeof SpendTopRun>;

const SpendRow = SpendFigure.extend({
  tokens: SpendTokens,
  /**
   * A principal public id, an agent key, a model id, a tool name, a task
   * reference, a cost-center label, an MCP server name,
   * {@link OTHER_SPEND_KEY}, or {@link ASSISTANT_SPEND_KEY}.
   */
  key: z.string().min(1),
  /** The model's provider on a model row; null elsewhere. */
  provider: z.string().nullable(),
  /** The person an operator row names; null on every other row. */
  operator: OperatorFacts.nullable(),
  /**
   * The row's costliest runs, at most eight. Absent from a view built
   * before get_spend listed them. Always empty on the
   * {@link ASSISTANT_SPEND_KEY} row.
   */
  topRuns: z.array(SpendTopRun).optional(),
});

/**
 * The runs a total counts and cannot price, because no frame reported what
 * they spent, by the harness that ran them (#3304). A harness whose model
 * calls pass through neither the gateway nor the local proxy records none.
 */
const UnmeteredRuns = z.object({
  total: Count,
  byHarness: z.array(z.object({ harness: z.string().min(1), runs: Count })),
});
export type UnmeteredRuns = z.infer<typeof UnmeteredRuns>;

/** One day of a spend series. */
const SpendDay = z.object({
  day: Day,
  cost: Cost.nullable(),
  calls: Count,
  runs: Count,
});

/** `get_spend` at one level: the period total and its groups, largest spend first. */
export const SpendReport = z.object({
  period: DayRange,
  total: SpendFigure,
  /**
   * One entry per day of the period, oldest first. Absent from a view built
   * before get_spend answered it.
   */
  days: z.array(SpendDay).optional(),
  /**
   * The part of the total the harness reported and the gateway did not
   * meter; null when there is none.
   */
  reported: Money.nullable().optional(),
  /** Runs still open whose cost is in these figures as a running estimate. */
  estimatedRuns: z.number().int().nonnegative().optional(),
  /** Runs in `total.runs` whose cost `total.cost` leaves out. */
  unmeteredRuns: UnmeteredRuns.optional(),
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
  series: z.array(SpendDay),
  perCall: Money.nullable(),
  perRun: Money.nullable(),
  /** The key's share of the workspace's spend over the window. */
  share: Ratio.nullable(),
  tools: z.array(
    z.object({ name: z.string().min(1), calls: Count, runs: Count }),
  ),
  /** The key's runs whose cost the total leaves out; absent on a tool drill. */
  unmeteredRuns: UnmeteredRuns.optional(),
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
      /**
       * The runs that prove the cause, largest waste first, each with the
       * session name the Fleet board shows, or null when it has none (#4571).
       */
      provingRuns: z.array(
        z.object({
          runId: PublicId.regex(RUN_PUBLIC_ID),
          name: z.string().nullable(),
        }),
      ),
    }),
  ),
});
export type SpendWaste = z.infer<typeof SpendWaste>;

/** Who a ranking row names: the person, or the pseudonym the workspace's setting shows instead. */
const RankedOperator = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("named"),
    /** The principal public id: the key, never the label. */
    key: z.string().min(1),
    facts: OperatorFacts.nullable(),
  }),
  z.object({
    kind: z.literal("pseudonym"),
    pseudonym: z.string().regex(/^Operator [0-9A-F]{8}$/),
  }),
]);

/**
 * `get_operator_ranking` (D15): the workspace's operators by unproductive
 * spend, highest first. The operator totals and `unattributed` sum to
 * `unproductive`. Under pseudonyms, `unproductiveShare` and `runs` are null
 * and `topRuns` is empty.
 */
export const OperatorRanking = z.object({
  period: DayRange,
  pseudonyms: z.boolean(),
  unproductive: Money,
  unattributed: z.object({ unproductive: Money, runs: Count }),
  operators: z.array(
    z.object({
      rank: z.number().int().positive(),
      operator: RankedOperator,
      unproductive: Money,
      shareOfTotal: Ratio,
      unproductiveShare: Ratio.nullable(),
      runs: z.number().int().positive().nullable(),
      /** The runs behind the figure, largest first. */
      topRuns: z.array(
        z.object({
          runId: PublicId.regex(RUN_PUBLIC_ID),
          unproductive: Money,
        }),
      ),
    }),
  ),
});
export type OperatorRanking = z.infer<typeof OperatorRanking>;
export type OperatorRankingRow = OperatorRanking["operators"][number];

/**
 * `get_spend_per_merged_pr` (spend spec, detector 8; F26): each agent's spend
 * on bounded runs per pull request that merged and stayed. A bounded run is a
 * run that opened a pull request. `perMergedPr` is null exactly when
 * `absence` says why, and the page prints it as absent, never as a zero.
 */
export const SpendPerMergedPr = z.object({
  period: DayRange,
  agents: z.array(
    z.object({
      agentKey: z.string().min(1),
      boundedRuns: z.number().int().positive(),
      unpricedRuns: Count,
      spend: Cost.nullable(),
      mergedPrs: Count,
      perMergedPr: Cost.nullable(),
      absence: z.enum(["no_merged_pr", "mixed_currency", "not_priced"]).nullable(),
      /** The costliest bounded runs, each with what its pull requests became. */
      runs: z.array(
        z.object({
          runId: PublicId.regex(RUN_PUBLIC_ID),
          startedAt: z.string(),
          cost: Cost.nullable(),
          pullRequests: z.array(
            z.object({
              prKey: z.string().min(1),
              url: z.string().nullable(),
              state: z.enum(["merged", "reverted", "closed", "open", "unread"]),
            }),
          ),
        }),
      ),
    }),
  ),
});
export type SpendPerMergedPr = z.infer<typeof SpendPerMergedPr>;
export type AgentPerMergedPr = SpendPerMergedPr["agents"][number];

/** The findings behind one figure beside the headline: their savings summed, and how many. */
const FindingFigure = z.object({ saving: Money, findings: Count });

/**
 * `get_unproductive_spend` (spend spec, Counting): the workspace's
 * unproductive spend for a period, the same total the operator ranking
 * totals. `spend` and `share` are null when the period's spend has no single
 * figure. `parts` holds detectors 2, 3, and 5 in that order and `estimate`
 * detector 4: each sits beside the headline and stays out of it.
 */
export const UnproductiveSpend = z.object({
  period: DayRange,
  unproductive: Money,
  spend: Money.nullable(),
  share: Ratio.nullable(),
  parts: z.array(
    FindingFigure.extend({
      detector: z.union([z.literal(2), z.literal(3), z.literal(5)]),
    }),
  ),
  estimate: FindingFigure,
});
export type UnproductiveSpend = z.infer<typeof UnproductiveSpend>;

/** An instant a contract carries as ISO 8601 in UTC. */
const Instant = z.iso.datetime();

/** The span a finding or a list of findings covers. */
const FindingWindow = z.object({ from: Instant, to: Instant });

/** The kinds the findings job detects (ADR-062's detector table, ADR-208). */
export const FINDING_KINDS = [
  "cache_writes_never_read",
  "duplicate_tool_calls",
  "repeated_shell_commands",
  "unpaged_results",
  "spin_loops",
  "standing_context",
  "idle_cache_rewrites",
  "cache_busts",
  "model_class_fit",
  "repeated_instructions",
  "recurring_runs",
  "spend_with_no_outcome",
  "retry_loops",
] as const;

const FindingKind = z.enum(FINDING_KINDS);

/** What a finding is about: a tool, an agent, an operator or the workspace. */
const FindingLevel = z.enum(["tool", "agent", "operator", "workspace"]);

/** The share of the cited calls the counterfactual covers, as the job graded it. */
const FindingConfidence = z.enum(["high", "medium"]);

/**
 * A setting a finding's fix names, with the value it proposes and, when the
 * detector read it, the value in effect. A cache finding names a cache TTL
 * (ADR-210).
 */
const FindingRecommendation = z.object({
  setting: z.string().min(1),
  value: z.union([z.string(), z.number()]),
  current: z.union([z.string(), z.number()]).optional(),
});

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
  /** The setting the fix names; absent when the fix names none. */
  recommendation: FindingRecommendation.optional(),
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
      /** The session name the Fleet board shows, or null when the run has none (#4571). */
      name: z.string().nullable(),
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
 * `get_tacho_session_policy`: what the loopback gateway refuses for a wrapped
 * Claude Code or Codex session in this workspace.
 *
 * A different ceiling from the ones above, and the page says so. Those are
 * Oxagen's own spend, metered as it bills. This one is somebody's laptop, and
 * the enforcer is the daemon on it, reading a signed bundle.
 *
 * `modelAllow` stays nullable through the view layer. `null` is *no
 * allowlist*, so every model is permitted; `[]` is an allowlist that permits
 * nothing. A page that rendered both as "no models listed" would show the
 * strictest policy the product has and the laxest one the same way.
 */
export const GatewayPolicy = z.object({
  mode: z.enum(["observed", "enforced"]),
  /**
   * The ceiling as the page prints it, through <Money> like every other
   * figure here (INV-09). The contract states it in whole dollars; the mapper
   * widens it to micros so one component formats every amount on the page.
   */
  sessionLimit: Money.nullable(),
  /** The same ceiling as the dialog's field takes it, in dollars. */
  sessionLimitUsd: z.number().nonnegative().nullable(),
  modelAllow: z.array(z.string()).nullable(),
  modelDeny: z.array(z.string()),
});
export type GatewayPolicy = z.infer<typeof GatewayPolicy>;

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
 * One class a model ran with no price covering it: how many calls used it,
 * how much of it they used, and the span of those calls. A rate added after
 * `from` leaves these calls unpriced, which is what the Pricing tab explains.
 */
const MissingClassWindow = z.object({
  tokenClass: PriceTokenClass,
  calls: Count,
  /** Tokens of the class, or requests for `server_tool_request`. */
  units: Count,
  from: Instant,
  to: Instant,
});
export type MissingClassWindow = z.infer<typeof MissingClassWindow>;

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
      /** One entry per missing class, in the contract's order. */
      missingClassWindows: z.array(MissingClassWindow),
      fullyUnpriced: z.boolean(),
    }),
  ),
});
export type UnpricedModels = z.infer<typeof UnpricedModels>;
