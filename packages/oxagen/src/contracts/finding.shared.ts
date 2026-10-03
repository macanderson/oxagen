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
import { RUN_LABEL_MAX, runPublicIdSchema } from "./run.list";
import { costSchema, moneySchema } from "./spend.shared";

/** The kinds the findings job writes (ADR-062, ADR-208). Mirrors `FINDING_KINDS` in the cost schema. */
const findingKindSchema = z.enum([
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
]);

/** Where a finding's fix applies: the level whose key `subject` carries. */
export const findingLevelSchema = z.enum([
  "tool",
  "agent",
  "operator",
  "workspace",
]);

const findingConfidenceSchema = z.enum(["high", "medium"]);

export const findingStatusSchema = z.enum(["open", "applied", "dismissed"]);

/** A finding's public id (`fnd_…`). */
const findingPublicIdSchema = z
  .string()
  .regex(/^fnd_[0-9a-z]+$/, "a finding public id (fnd_…)");

/**
 * A setting a finding's fix names, with the value it proposes and, when the
 * findings job read it, the value in effect. A cache finding names a cache
 * TTL (ADR-210).
 */
export const findingRecommendationSchema = z
  .object({
    setting: z.string().min(1),
    value: z.union([z.string(), z.number()]),
    current: z.union([z.string(), z.number()]).optional(),
  })
  .strict();
export type FindingRecommendation = z.output<
  typeof findingRecommendationSchema
>;

const countSchema = z.number().int().nonnegative();
const positiveSchema = z.number().int().positive();

/**
 * What a workspace keeps of prompt and tool text: `content_exact` keeps the
 * text, and `digest_only` keeps a digest of it alone.
 */
const findingRetentionSchema = z.enum(["content_exact", "digest_only"]);

/** Results and the re-reads of them, one side of detector 5's split. */
const findingResultSideSchema = z
  .object({ results: countSchema, reads: countSchema })
  .strict();

/**
 * Each kind's figures, as the spend spec's finding text names them (#5023).
 * The Spend card writes its text from these and from the finding's runs,
 * calls, and saving. A finding the job wrote before it stored values has
 * none, and the card shows the detector's own text (`why`) instead.
 * `duplicate_tool_calls` and `repeated_shell_commands` carry none, because
 * their text names only the runs, the calls, and the saving.
 */
export const findingValuesSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("spin_loops"),
      /** The tool of the longest loop in one cited run. */
      tool: z.string().min(1),
      /** How many times in a row that loop made the call and got the same result. */
      repeats: positiveSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("retry_loops"),
      /** The tool of the longest streak of failures in one cited run. */
      tool: z.string().min(1),
      /** How many times in a row that call failed with the same error. */
      failures: positiveSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("standing_context"),
      /** The tokens the priced runs re-sent on every model call after the first. */
      resentTokens: countSchema,
      /** That figure by source; null for a source no run reported. */
      toolDefinitionTokens: countSchema.nullable(),
      steeringTokens: countSchema.nullable(),
      contextFrameTokens: countSchema.nullable(),
      /**
       * The tool provider whose definitions add the most tokens to a
       * request, from the cited runs whose frames the job read. Null when no
       * such frame listed a provider's tools.
       */
      provider: z
        .object({
          name: z.string().min(1),
          /** The tokens its definitions add to every request. */
          tokens: countSchema,
          /** The tools it lists. */
          tools: positiveSchema,
          /** Of those, the tools the cited runs called in the window. */
          toolsCalled: countSchema,
          /** Its tokens at the weekly price per 1,000; null when the week has no price. */
          weeklyPrice: costSchema.nullable(),
        })
        .strict()
        .nullable(),
      /**
       * What 1,000 tokens sent on every request cost the workspace over the
       * last 7 days, the price the tool and steering pages quote. Null when
       * the book could not price every request of the week.
       */
      weeklyPricePerThousand: costSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("model_class_fit"),
      /** The model with the largest measured cost among the moves. */
      model: z.string().min(1),
      /** The model one class smaller that the job repriced it at. */
      lighterModel: z.string().min(1),
      /** Cited runs that changed no file, priced whole. */
      unchangedRuns: countSchema,
      /** Cited runs with edit steps, priced on their read-only steps. */
      editedRuns: countSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("repeated_instructions"),
      /** What the workspace keeps of prompt text. */
      retention: findingRetentionSchema,
      /**
       * The most repeated sentence, cut to 160 characters. Null on a
       * `digest_only` workspace, which keeps no text to quote.
       */
      sentence: z.string().min(1).nullable(),
      /** How many prompts carried it. */
      prompts: positiveSchema,
      /** The runs those prompts went to. */
      promptRuns: positiveSchema,
      /** Other sentences or whole prompts the finding also cites. */
      others: countSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("recurring_runs"),
      /**
       * The runs the top recurring prompt started: the prompt with the most
       * runs that changed nothing.
       */
      groupSize: positiveSchema,
      /** Of those, the runs that changed nothing. */
      unchanged: countSchema,
      /** Other recurring prompts the finding also cites. */
      otherPrompts: countSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("spend_with_no_outcome"),
      /** Cited runs whose pull requests all closed unmerged. */
      closedUnmerged: countSchema,
      /** Cited runs with a pull request reverted soon after its merge. */
      reverted: countSchema,
      /** Cited runs abandoned before they opened a pull request. */
      abandoned: countSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("cache_writes_never_read"),
      /** The prompt-cache tokens the cited runs wrote. */
      writtenTokens: countSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("idle_cache_rewrites"),
      /** The shortest and longest wait the finding cites, in whole minutes. */
      minWaitMinutes: countSchema,
      maxWaitMinutes: countSchema,
      /** The tokens each wait rewrote, on average. */
      averageTokens: countSchema,
      /** What keep-alive reads would have cost over the priced rewrites. */
      keepAlive: moneySchema,
      /** What the priced rewrites cost. */
      rewrites: moneySchema,
      /** The rewrites a price covers; the rest are cited at no price. */
      pricedRewrites: countSchema,
      /** The rewrites whose cause is unknown, because no system context digest was recorded. */
      unknownRewrites: countSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("cache_busts"),
      /** The part of the system context that changed first most often; null when no bust recorded one. */
      firstChange: z.string().min(1).nullable(),
      /** The busts that began there; null with `firstChange`. */
      firstChangeBusts: positiveSchema.nullable(),
      /** The busts a price covers; the rest are cited at no price. */
      pricedBusts: countSchema,
      /** The busts whose requests recorded no system context digest. */
      unknownBusts: countSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("unpaged_results"),
      /** The results over 5,000 tokens the finding cites. */
      results: countSchema,
      /**
       * What the workspace keeps of tool and model call text, which decides
       * whether a quote could be checked. Null when the job read no signal.
       */
      retention: findingRetentionSchema.nullable(),
      /** Results a later step quoted; their re-reads add nothing to the saving. */
      quoted: findingResultSideSchema,
      /** Results no step could be checked for, counted in full: an upper bound. */
      unchecked: findingResultSideSchema,
    })
    .strict(),
]);
export type FindingValues = z.output<typeof findingValuesSchema>;

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
    /** The setting the fix names. Absent when the fix names none. */
    recommendation: findingRecommendationSchema.optional(),
    /**
     * The kind's figures its finding text names. Absent on a finding written
     * before the job stored them, and on a kind whose text needs none.
     */
    values: findingValuesSchema.optional(),
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
    /** The session name the Fleet board shows, or null when the run has none (#4571). */
    name: z.string().max(RUN_LABEL_MAX).nullable(),
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
     * (`cache_writes_never_read`, `standing_context`, `model_class_fit`). It
     * pins no turn, and `frames` is empty.
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
