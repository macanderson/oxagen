// Runs, frames and everything the Run page reads (spec §8, plan §4.5).
import { z } from "zod";
import {
  AgentKey,
  CallDecision,
  CommitSha,
  Count,
  Digest,
  EnforcementTier,
  Instant,
  Money,
  PublicId,
  Ratio,
  ReplayGrade,
  Slug,
  Verdict,
} from "./common";

export const RunStatus = z.enum([
  "live",
  "parked",
  "pausing",
  "paused",
  "resuming",
  "sealed",
  "halted",
  "compacted",
]);
export type RunStatus = z.infer<typeof RunStatus>;

/** Fleet's list filter. */
export const RunFilter = z.enum(["all", "live", "proven"]);
export type RunFilter = z.infer<typeof RunFilter>;

export const RunRow = z.object({
  id: PublicId,
  /** Feedback 4: the light-tier run name. Null until G14 lands; never invented. */
  name: z.string().nullable(),
  agentKey: AgentKey,
  operatorId: PublicId,
  workspaceSlug: Slug,
  status: RunStatus,
  turns: Count,
  steps: Count,
  frames: Count,
  cost: Money,
  /** Null = not recorded; the badge says so rather than guessing. */
  tier: EnforcementTier.nullable(),
  grade: ReplayGrade.nullable(),
  /** The witness verdict. Null until verdicts are recorded (G7); `getRun` is wired at M0. */
  verdict: Verdict.nullable(),
  /** An issue, a PR or free text (spec §8.1). */
  taskRef: z.string().nullable(),
  startedAt: Instant,
  sealedAt: Instant.nullable(),
});
export type RunRow = z.infer<typeof RunRow>;

export const RunPage = z.object({
  rows: z.array(RunRow),
  next: z.string().nullable(),
});
export type RunPage = z.infer<typeof RunPage>;

export const RunSummary = z.object({
  text: z.string(),
  /** The concrete model that wrote it (a light-tier model, G14). */
  model: z.string(),
  /** The frame count the summary was written against. */
  frameCount: Count,
  /** When it was written: at a turn boundary or at seal. */
  writtenAt: z.enum(["turn_boundary", "seal", "halt"]),
});
export type RunSummary = z.infer<typeof RunSummary>;

export const RunDetail = RunRow.extend({
  model: z.string(),
  cacheHitRate: Ratio,
  // Null means not recorded: `getRun` is wired at M0, but proven spend needs
  // the witness flip and cost.run_totals (G7, M6). Never a zero stand-in.
  /** Spend on turns a witness proved. Null until G7. */
  provenSpend: Money.nullable(),
  /** Proven over total spend. Null until G7. */
  productiveRatio: Ratio.nullable(),
  summary: RunSummary.nullable(),
  /**
   * What the run touched, as short references (issues, branches, files). Null
   * until the run's work graph is recorded (G6); empty means recorded and none.
   */
  touched: z.array(z.string()).nullable(),
});
export type RunDetail = z.infer<typeof RunDetail>;

// ---- Frames ------------------------------------------------------------------

export const FrameKind = z.enum([
  "agent.start",
  "context.assembled",
  "model.request",
  "model.response",
  "tool.requested",
  "policy.decision",
  "token.issued",
  "tool.result",
  "control.steer",
  "control.pause",
  "control.resume",
  "approval.request",
  "telemetry_gap",
]);
export type FrameKind = z.infer<typeof FrameKind>;

export const Frame = z.object({
  /** Decimal `run_seq`, the SSE cursor. Dense from 0. */
  seq: z.string().regex(/^\d+$/),
  kind: FrameKind,
  ts: Instant,
  tier: EnforcementTier.nullable(),
  cost: Money.nullable(),
  summary: z.string(),
  hash: z.string().nullable(),
  prevHash: z.string().nullable(),
});
export type Frame = z.infer<typeof Frame>;

// ---- Transcript: the model-visible projection of a run's frames ----------------

const TranscriptBase = z.object({
  /** Seconds from the run's first frame. */
  offsetSeconds: z.number().nonnegative(),
  /** The governed frame the gateway wrote for this entry, when there is one. */
  frameSeq: Count.nullable(),
});

export const ToolClass = z.enum(["repo", "inspect", "mutate", "verify"]);
export type ToolClass = z.infer<typeof ToolClass>;

export const FileDiff = z.object({
  path: z.string(),
  before: z.string(),
  after: z.string(),
});
export type FileDiff = z.infer<typeof FileDiff>;

export const TranscriptEntry = z.discriminatedUnion("kind", [
  TranscriptBase.extend({
    kind: z.literal("prompt"),
    body: z.string(),
    taskRef: z.string().nullable(),
    byPersonId: PublicId,
  }),
  TranscriptBase.extend({
    kind: z.literal("context_recall"),
    contextFrames: Count,
    tokens: Count,
    candidatesScored: Count,
    durationMs: z.number().nonnegative(),
  }),
  TranscriptBase.extend({ kind: z.literal("reasoning"), body: z.string() }),
  TranscriptBase.extend({ kind: z.literal("text"), body: z.string() }),
  TranscriptBase.extend({
    kind: z.literal("usage"),
    model: z.string(),
    tokensIn: Count,
    cacheRead: Count,
    tokensOut: Count,
    cost: Money,
    providerRequestId: z.string(),
  }),
  TranscriptBase.extend({
    kind: z.literal("tool"),
    tool: z.string(),
    toolClass: ToolClass,
    argument: z.string(),
    rawInput: z.string(),
    decision: z
      .object({ outcome: CallDecision, rule: z.string(), frameSeq: Count })
      .nullable(),
    result: z
      .object({
        durationMs: z.number().nonnegative(),
        isError: z.boolean(),
        body: z.string(),
      })
      .nullable(),
    diff: FileDiff.nullable(),
    parked: z.object({ approvalId: PublicId, frameSeq: Count }).nullable(),
  }),
  TranscriptBase.extend({
    kind: z.literal("steer"),
    body: z.string(),
    byPersonId: PublicId,
    tokens: Count,
  }),
]);
export type TranscriptEntry = z.infer<typeof TranscriptEntry>;

// ---- The run's neighbourhood in the graph -----------------------------------------

/** Who wrote an edge: the gateway saw it, the task stated it, or a model inferred it. */
export const EdgeOrigin = z.enum(["observed", "stated", "inferred"]);
export type EdgeOrigin = z.infer<typeof EdgeOrigin>;

const GraphEdge = z.object({
  origin: EdgeOrigin,
  /** Only inferred edges carry a confidence. */
  confidence: Ratio.nullable(),
  frameSeqs: z.array(Count),
});

export const RunGraph = z.object({
  repositories: z.array(
    GraphEdge.extend({
      fullName: z.string(),
      ref: z.string(),
      note: z.string(),
    }),
  ),
  issues: z.array(
    GraphEdge.extend({
      ref: z.string(),
      title: z.string(),
      relation: z.string(),
    }),
  ),
  artifacts: z.array(
    GraphEdge.extend({
      kind: z.enum(["branch", "release", "pr", "witness", "comment"]),
      ref: z.string(),
      title: z.string(),
      state: z.string(),
    }),
  ),
  files: z.array(FileDiff.extend({ note: z.string() })),
});
export type RunGraph = z.infer<typeof RunGraph>;

// ---- Context window (G10) -------------------------------------------------------

export const ContextWindow = z.object({
  requestFrameSeq: Count,
  requestedAt: Instant,
  totalTokens: Count,
  cachedTokens: Count,
  freshTokens: Count,
  compositionDigest: Digest,
  budgetTokens: Count,
  usedTokens: Count,
  headroomTokens: Count,
  candidatesScored: Count,
  framesAdmitted: Count,
  framesHeld: Count,
  scoreFloorPercent: Count,
  blocks: z.array(
    z.object({
      id: z.enum(["identity", "steering", "tools", "frames", "task"]),
      position: Count,
      name: z.string(),
      tokens: Count,
      cache: z.enum(["read", "mixed", "new"]),
    }),
  ),
  admitted: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["fact", "doc", "symbol", "episode", "memory"]),
      tokens: Count,
      score: Ratio,
      citations: Count.nullable(),
      grain: z.enum(["L0", "L1", "L2", "L3"]),
      label: z.string(),
      nodeId: z.string(),
    }),
  ),
  excluded: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["fact", "doc", "symbol", "episode", "memory"]),
      tokens: Count,
      score: Ratio,
      reason: z.enum(["cap", "grain", "permission"]),
      label: z.string(),
    }),
  ),
});
export type ContextWindow = z.infer<typeof ContextWindow>;

// ---- Proof: the witness flip (G7) ---------------------------------------------

export const OracleKind = z.enum([
  "test_flip",
  "build_or_type",
  "property",
  "golden",
  "contract",
]);
export type OracleKind = z.infer<typeof OracleKind>;

const FramePoint = z.object({ at: Instant, seq: Count });

export const RunProof = z.object({
  oracle: OracleKind,
  testKind: z.string(),
  runner: z.string(),
  command: z.string(),
  commandDigest: Digest,
  witnessId: PublicId,
  target: z.object({ ref: z.string(), sha: CommitSha }),
  pullRequest: z.object({ ref: z.string(), sha: CommitSha }),
  turn: Count,
  turnStart: FramePoint,
  /** Null when the witness never flipped. */
  flipped: FramePoint.nullable(),
  turnEnd: FramePoint,
  sealed: FramePoint,
  fingerprint: z.enum(["held", "moved"]),
  segmentId: PublicId,
  /** Fingerprints held out of the worker's view, e.g. "2 of 5". */
  heldOut: z.object({ held: Count, of: Count }),
  attempts: z.array(
    z.object({
      n: Count,
      result: z.enum(["pass", "fail"]),
      at: Instant,
      seq: Count,
      durationMs: Count,
      exitCode: z.number().int(),
      note: z.string(),
    }),
  ),
});
export type RunProof = z.infer<typeof RunProof>;
