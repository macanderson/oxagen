/**
 * The Model fit reading (#3893): whether the model class and the effort
 * setting were the right size for one sealed run. It is computed from the
 * record after the seal, stored on the run, and versioned `run-fit/v1`. The
 * durable function that writes it and the Run page that reads it share this
 * one shape and this one rule, so they cannot disagree.
 *
 * The reading is keyed on what the record varies: prompts, failed tool calls,
 * turns and steps. It is never keyed on reasoning share for the model, which
 * is a fixed fraction of output per model family and so describes the model,
 * not the run. It names a capability class one rung up or down the vendor's
 * own family, never a model id: which id serves a class is the agent
 * definition's choice.
 *
 * It is generated, not the record. It argues for a change to the agent
 * definition and changes nothing on its own.
 */
import { z } from "zod";

/** The rule version a stored reading was computed under. */
export const RUN_FIT_METHOD = "run-fit/v1";

/**
 * Each vendor family's capability classes, smallest first, as a run's
 * `model.tier` names them. A class absent here has no rung this reading
 * claims.
 */
export const MODEL_CLASS_LADDERS: readonly (readonly string[])[] = [
  ["haiku", "sonnet", "opus"],
  ["nano", "mini"],
  ["flash-lite", "flash", "pro"],
];

/** The effort settings the reading moves between, lowest first. */
export const EFFORT_LADDERS: readonly (readonly string[])[] = [
  ["low", "medium", "high"],
];

/** Where an effort value was read: a proxied request body, or the harness's own report. */
export const runEffortSourceSchema = z.enum(["request", "harness"]);

/** The figures the reading read; each came from the sealed record. */
export const runFitReadSchema = z
  .object({
    prompts: z.number().int().nonnegative(),
    turns: z.number().int().nonnegative(),
    steps: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    /** Null when the rollup recorded no output tokens. */
    outputTokens: z.number().int().nonnegative().nullable(),
    /** Null when the rollup recorded no reasoning tokens. */
    reasoningTokens: z.number().int().nonnegative().nullable(),
  })
  .strict();

/** The model class verdict, with the class one rung down (over) or up (under). */
export const runModelFitSchema = z.discriminatedUnion("verdict", [
  z.object({ verdict: z.literal("fit"), tier: z.string() }).strict(),
  z
    .object({
      verdict: z.enum(["over", "under"]),
      tier: z.string(),
      suggest: z.string(),
    })
    .strict(),
]);

/**
 * The effort verdict. `unseen` says why no effort was read: `not_sent` where
 * Oxagen proxied the calls and the request carried none, `not_proxied`
 * elsewhere.
 */
export const runEffortFitSchema = z.discriminatedUnion("verdict", [
  z
    .object({
      verdict: z.literal("fit"),
      effort: z.string().max(32),
      source: runEffortSourceSchema,
    })
    .strict(),
  z
    .object({
      verdict: z.enum(["over", "under"]),
      effort: z.string().max(32),
      source: runEffortSourceSchema,
      suggest: z.string().max(32),
    })
    .strict(),
  z
    .object({
      verdict: z.literal("unseen"),
      why: z.enum(["not_proxied", "not_sent"]),
    })
    .strict(),
]);

/** The reading as the run stores it, without its provenance. */
export const runFitReadingSchema = z
  .object({
    /** Null when the record lacks a figure the reading is keyed on. */
    read: runFitReadSchema.nullable(),
    /** Null when `read` is null or the model's class sits on no known ladder. */
    model: runModelFitSchema.nullable(),
    effort: runEffortFitSchema,
  })
  .strict();

/** The reading with its provenance: the rule, when it was read, and which seal. */
export const runFitSchema = runFitReadingSchema
  .extend({
    method: z.literal(RUN_FIT_METHOD),
    /** RFC 3339: when the reading was computed. */
    readAt: z.string().datetime(),
    /** RFC 3339: the seal the reading read. */
    sealedAt: z.string().datetime(),
  })
  .strict();

export type RunEffortSource = z.output<typeof runEffortSourceSchema>;
export type RunFitRead = z.output<typeof runFitReadSchema>;
export type RunModelFit = z.output<typeof runModelFitSchema>;
export type RunEffortFit = z.output<typeof runEffortFitSchema>;
export type RunFitReading = z.output<typeof runFitReadingSchema>;
export type RunFit = z.output<typeof runFitSchema>;

/** What `runFit` reads: the run's class and effort, and the figures its record holds. */
export interface RunFitInput {
  /** The run's model class (`modelTierOf`); null when the id names none. */
  tier: string | null;
  /** The effort the record holds; null when it holds none. */
  effort: string | null;
  /** Where `effort` was read; null exactly when `effort` is. */
  effortSource: RunEffortSource | null;
  /** Whether Oxagen proxied the run's model calls (the gateway and contained tiers). */
  proxied: boolean;
  read: RunFitRead | null;
}

/**
 * The reading for one sealed run. Pure: the caller reads the record and
 * stores the answer.
 *
 * The Effort and tools lane writes the rule (#3893), ported from the app's
 * `features/run/fit.ts` and the mockup's effort rule. Until then it refuses,
 * and nothing calls it.
 */
export function runFit(_input: RunFitInput): RunFitReading {
  throw new Error("runFit: not implemented (#3893)");
}
