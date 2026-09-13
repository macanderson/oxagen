// The Spend page: totals, attribution, waste, drills, findings and
// reconciliation (spec §12, App. A.7 `cost.run_totals`, `cost.reconciliations`).
import { z } from "zod";
import {
  AgentKey,
  CostBasis,
  Count,
  Instant,
  Money,
  PublicId,
  Ratio,
} from "./common";
import { ServerId } from "./tools";

export const SpendSummary = z.object({
  /** `YYYY-MM`. */
  period: z.string().regex(/^\d{4}-\d{2}$/),
  total: Money,
  proven: Money,
  /** A human verified the outcome without a witness. */
  accepted: Money,
  unproven: Money,
  productiveRatio: Ratio,
  cacheHitRate: Ratio,
  runs: Count,
  governedActions: Count,
});
export type SpendSummary = z.infer<typeof SpendSummary>;

export const SpendByOperator = z.object({
  operatorId: PublicId,
  agents: Count,
  runs: Count,
  spend: Money,
  proven: Money,
  productiveRatio: Ratio,
  budget: Money,
  budgetUsedRatio: Ratio,
});
export type SpendByOperator = z.infer<typeof SpendByOperator>;

export const SpendByAgent = z.object({
  agentKey: AgentKey,
  runs: Count,
  spend: Money,
  proven: Money,
  /** Null when the agent has no proven run to divide by. */
  perProvenRun: Money.nullable(),
  /** Change against the previous period, in percent. */
  trendPercent: z.number(),
});
export type SpendByAgent = z.infer<typeof SpendByAgent>;

export const SpendByModel = z.object({
  model: z.string(),
  /** The in-app agent's own model use, reported apart from customer agents. */
  assistant: z.boolean(),
  calls: Count,
  spend: Money,
  cacheHitRate: Ratio,
});
export type SpendByModel = z.infer<typeof SpendByModel>;

export const SpendByTool = z.object({
  /** Null for turns that called no tool. */
  tool: z.string().nullable(),
  serverId: ServerId.nullable(),
  calls: Count,
  runs: Count,
  spend: Money,
  perCall: Money.nullable(),
  perRun: Money,
  note: z.string().nullable(),
});
export type SpendByTool = z.infer<typeof SpendByTool>;

export const WasteCause = z.enum([
  "unproven_outcome",
  "cache_misses",
  "retry_loops",
  "context_bloat",
  "idle_while_parked",
  "halted_early",
]);
export type WasteCause = z.infer<typeof WasteCause>;

export const BadgeTone = z.enum([
  "critical",
  "failed",
  "denied",
  "approval",
  "allowed",
  "neutral",
]);
export type BadgeTone = z.infer<typeof BadgeTone>;

export const WasteReport = z.object({
  total: Money,
  share: Ratio,
  runs: Count,
  causes: z.array(
    z.object({ cause: WasteCause, spend: Money, runs: Count, why: z.string() }),
  ),
  worstRuns: z.array(
    z.object({
      runId: PublicId,
      wasted: Money,
      badges: z.array(z.object({ label: z.string(), tone: BadgeTone })),
      what: z.string(),
    }),
  ),
});
export type WasteReport = z.infer<typeof WasteReport>;

/** One cross-cut row in a drill. `key` is null for rows that are not themselves drillable. */
export const SpendSlice = z.object({
  key: z.string().nullable(),
  label: z.string(),
  spend: Money,
});
export type SpendSlice = z.infer<typeof SpendSlice>;

export const DrillKind = z.enum(["operator", "agent", "tool"]);
export type DrillKind = z.infer<typeof DrillKind>;

export const SpendDrill = z.object({
  kind: DrillKind,
  id: z.string(),
  cacheHitRate: Ratio,
  wasted: Money,
  accepted: Money.nullable(),
  unproven: Money.nullable(),
  perRun: Money.nullable(),
  productiveRatio: Ratio.nullable(),
  provenShare: Ratio.nullable(),
  resultTokens: Count.nullable(),
  rerunRate: Ratio.nullable(),
  retryRate: Ratio.nullable(),
  trend: z.string(),
  modelCalls: Count.nullable(),
  toolCalls: Count.nullable(),
  agents: z.array(SpendSlice),
  operators: z.array(SpendSlice),
  tools: z.array(SpendSlice),
  models: z.array(SpendSlice),
});
export type SpendDrill = z.infer<typeof SpendDrill>;

// ---- Findings (G4) -----------------------------------------------------------

export const FindingKind = z.enum([
  "unpaged_results",
  "repeated_shell_commands",
  "tool_list_bloat",
  "cache_misses_after_prefix_change",
  "refetching_stable_list",
  "duplicate_tool_calls",
  "wrong_tier",
  "unproductive_tail",
  "cache_writes_never_read",
]);
export type FindingKind = z.infer<typeof FindingKind>;

export const FindingLevel = z.enum(["tool", "agent", "workspace", "operator"]);
export type FindingLevel = z.infer<typeof FindingLevel>;

export const Finding = z.object({
  id: PublicId,
  kind: FindingKind,
  level: FindingLevel,
  /** The tool name, agent key, workspace slug or person id the finding is about. */
  subject: z.string(),
  saving: Money,
  window: z.string(),
  why: z.string(),
  fix: z.string(),
  scope: z.string(),
});
export type Finding = z.infer<typeof Finding>;

export const CitedRun = z.object({
  /** Null when the cited run is outside the recorded window. */
  runId: PublicId.nullable(),
  task: z.string(),
  at: z.string(),
  cost: Money,
  wasted: Money,
  note: z.string(),
});
export type CitedRun = z.infer<typeof CitedRun>;

export const FindingEvidence = z.object({
  findingId: PublicId,
  confidence: z.enum(["high", "medium", "low"]),
  trend: z.string(),
  basis: CostBasis,
  signal: z.string(),
  measured: z.string(),
  baseline: z.string(),
  counterfactual: z.string(),
  method: z.array(z.object({ step: z.string(), text: z.string() })),
  /** Null agent key: the finding spans several agents (`scope` says which). */
  who: z.object({
    agentKey: AgentKey.nullable(),
    scope: z.string(),
    operatorId: PublicId,
    note: z.string(),
  }),
  runs: z.array(CitedRun),
});
export type FindingEvidence = z.infer<typeof FindingEvidence>;

const CodeSample = z.object({ language: z.string(), code: z.string() });

export const FindingFix = z.discriminatedUnion("shape", [
  z.object({
    shape: z.literal("article"),
    findingId: PublicId,
    title: z.string(),
    why: z.string(),
    before: CodeSample,
    after: CodeSample,
    steps: z.array(z.string()),
    action: z.string(),
    done: z.string(),
  }),
  z.object({
    shape: z.literal("context_pr"),
    findingId: PublicId,
    lineage: z.string(),
    statement: z.string(),
    enforcement: z.enum(["require", "forbid"]),
    pullRequestRef: z.string(),
    branch: z.string(),
  }),
]);
export type FindingFix = z.infer<typeof FindingFix>;

// ---- Reconciliation (G5) -------------------------------------------------------

export const ReconciliationSummary = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
  matchedRatio: Ratio,
  variance: Money,
  exceptions: Count,
  checkedAt: Instant,
});
export type ReconciliationSummary = z.infer<typeof ReconciliationSummary>;
