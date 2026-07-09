import { z } from "zod";

// Shared Zod schemas for the eval.* capability family. Declared once here so the
// contracts, handlers, the run executor, and the UI never drift on the shape of
// a dataset item, a run target, or a judge score.

/** A single eval case: the input to run, an optional gold answer, and metadata. */
export const evalDatasetItemSchema = z.object({
  /** The prompt/question handed to the target. */
  input: z.string().min(1),
  /** The known-good answer, when one exists — the judge scores against it. */
  expectedOutput: z.string().optional(),
  /** Free-form provenance (e.g. { messageId, capability } for trace-sourced items). */
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type EvalDatasetItem = z.output<typeof evalDatasetItemSchema>;

/**
 * The thing under evaluation. v1 supports a bare model+prompt or an existing
 * agent (run through its published instruction prompt). Both paths execute via
 * @oxagen/ai so every call is metered.
 */
export const evalTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("model"),
    /** Gateway model slug; omitted → the balanced tier is used. */
    model: z.string().min(1).optional(),
    /** System instruction prepended to every item's input. */
    systemPrompt: z.string().optional(),
  }),
  z.object({
    kind: z.literal("agent"),
    /** Slug of an agent definition in this workspace. */
    agentSlug: z.string().min(1),
  }),
]);
export type EvalTarget = z.output<typeof evalTargetSchema>;

/**
 * The structured verdict the LLM judge must return per item. `score` is the
 * overall in [0,1]; `correctness` measures agreement with the expected output,
 * `faithfulness` measures grounding in any cited context (both in [0,1]).
 */
export const evalJudgeScoreSchema = z.object({
  correctness: z.number().min(0).max(1),
  faithfulness: z.number().min(0).max(1),
  score: z.number().min(0).max(1),
  rationale: z.string(),
});
export type EvalJudgeScore = z.output<typeof evalJudgeScoreSchema>;

/** Lifecycle of an eval run. */
export const evalRunStatusSchema = z.enum([
  "pending",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type EvalRunStatus = z.output<typeof evalRunStatusSchema>;
