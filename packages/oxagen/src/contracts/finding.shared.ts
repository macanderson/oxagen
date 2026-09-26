/**
 * The vocabulary the finding contracts share (Mission Control spec §12.8,
 * App. E `list_findings`; ADR-062). Not a capability: this file registers
 * nothing.
 *
 * A finding's saving is a cost with a basis (INV-09, INV-10): the findings
 * job's figure, measured minus counterfactual over the runs it cites, at the
 * price each run paid, with the confidence the job assigned. Nothing on the
 * wire is estimated by the reader.
 */
import { z } from "zod";
import { runPublicIdSchema } from "./run.list";
import { costSchema, moneySchema } from "./spend.shared";

const findingKindSchema = z.enum([
  "cache_writes_never_read",
  "duplicate_tool_calls",
  "repeated_shell_commands",
  "unpaged_results",
]);

const findingLevelSchema = z.enum(["tool", "agent", "operator", "workspace"]);

const findingConfidenceSchema = z.enum(["high", "medium"]);

export const findingStatusSchema = z.enum(["open", "applied", "dismissed"]);

/** A finding's public id (`fnd_…`). */
const findingPublicIdSchema = z
  .string()
  .regex(/^fnd_[0-9a-z]+$/, "a finding public id (fnd_…)");

export const findingSchema = z
  .object({
    id: findingPublicIdSchema,
    kind: findingKindSchema,
    level: findingLevelSchema,
    /** The level's key: a tool name, an agent key, an operator's `prn_…`, or the workspace id. */
    subject: z.string(),
    saving: costSchema,
    confidence: findingConfidenceSchema,
    window: z
      .object({ from: z.string().datetime(), to: z.string().datetime() })
      .strict(),
    why: z.string(),
    fix: z.string(),
    /** Runs and calls the finding cites. */
    runs: z.number().int().positive(),
    calls: z.number().int().positive(),
    status: findingStatusSchema,
    detectedAt: z.string().datetime(),
    decidedAt: z.string().datetime().nullable(),
    /** The request id of the invocation that applied the fix; its audit row carries the same id. */
    appliedActionId: z.string().nullable(),
  })
  .strict();
export type Finding = z.output<typeof findingSchema>;

const findingRunEvidenceSchema = z
  .object({
    runId: runPublicIdSchema,
    startedAt: z.string().datetime(),
    calls: z.number().int().positive(),
    measuredTokens: z.number().int().nonnegative(),
    counterfactualTokens: z.number().int().nonnegative(),
    measured: moneySchema,
    counterfactual: moneySchema,
  })
  .strict();

/** The arithmetic behind a saving: what the cited calls cost and what the alternative would have. */
export const findingEvidenceSchema = z
  .object({
    calls: z.number().int().positive(),
    /** Calls the counterfactual prices; the rest are cited and add nothing to the saving. */
    coveredCalls: z.number().int().nonnegative(),
    measuredTokens: z.number().int().nonnegative(),
    counterfactualTokens: z.number().int().nonnegative(),
    measured: moneySchema,
    counterfactual: moneySchema,
    /** The cited runs with the largest saving, at most ten. */
    runs: z.array(findingRunEvidenceSchema).max(10),
  })
  .strict();
export type FindingEvidence = z.output<typeof findingEvidenceSchema>;

/** The most cited frames one finding carries for one run (#4001). */
export const FINDING_FRAMES_PER_RUN = 50;

/**
 * One tool call a finding cites, by its frame. `sessionUuid` names the
 * subagent chain the frame was recorded on and is absent on the run's own
 * chain, as on a transcript body.
 */
export const findingCitedFrameSchema = z
  .object({
    seq: z.string().regex(/^\d{1,19}$/),
    sessionUuid: z.string().uuid().optional(),
  })
  .strict();

/**
 * What a finding cites in one run, answered when a read asks for the findings
 * of that run (#4001).
 */
export const findingRunCitationSchema = z
  .object({
    runId: runPublicIdSchema,
    /**
     * True for a finding that cites the run as a whole
     * (`cache_writes_never_read`). It pins no turn, and `frames` is empty.
     */
    runLevel: z.boolean(),
    /**
     * The cited frames, seqs ascending, at most `FINDING_FRAMES_PER_RUN`.
     * Null when the finding was written before frames were cited.
     */
    frames: z
      .array(findingCitedFrameSchema)
      .max(FINDING_FRAMES_PER_RUN)
      .nullable(),
    /**
     * Every call the finding cites in the run, including any past the cap.
     * On a finding written before frames were cited, the calls its evidence
     * counted in the run. Null when that evidence did not itemise the run,
     * which it does for the ten runs with the largest saving.
     */
    framesTotal: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type FindingRunCitation = z.output<typeof findingRunCitationSchema>;

/** The finding a decision is taken on. */
export const findingDecisionInputSchema = z
  .object({ findingId: findingPublicIdSchema })
  .strict();
