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

/** A run this short, landed first try, is a small job for any model. */
const SMALL_TURNS = 3;
const SMALL_STEPS = 12;

/**
 * The share of output a first-try run may spend reasoning before the reading
 * argues for less effort: the mockup's `runFit` bound (engine.js:2369).
 */
const REASONING_SHARE_OVER = 0.2;

/** The longest effort word the reading stores: the schema's bound. */
const EFFORT_MAX = 32;

/** Where a value sits on the first ladder that holds it, or null. */
function rungOf(
  ladders: readonly (readonly string[])[],
  value: string | null,
): { ladder: readonly string[]; rank: number } | null {
  if (value === null) return null;
  for (const ladder of ladders) {
    const rank = ladder.indexOf(value);
    if (rank !== -1) return { ladder, rank };
  }
  return null;
}

/** The operator prompted again, or a tool call failed: the run was redone. */
const redone = (read: RunFitRead): boolean =>
  read.prompts > 1 || read.failed > 0;

/**
 * The model class verdict. Down a rung when a small job landed first try;
 * up a rung when the run had to be redone, whatever its size, because a
 * retry outweighs a short run. Anything else fits, and so does a class at
 * the end of its ladder, where no rung is left to argue for.
 */
function modelFit(tier: string | null, read: RunFitRead): RunModelFit | null {
  const rung = rungOf(MODEL_CLASS_LADDERS, tier);
  if (tier === null || rung === null) return null;
  const small = read.turns <= SMALL_TURNS || read.steps <= SMALL_STEPS;
  const lower = rung.ladder[rung.rank - 1];
  const higher = rung.ladder[rung.rank + 1];
  if (!redone(read) && small && lower !== undefined)
    return { verdict: "over", tier, suggest: lower };
  if (redone(read) && higher !== undefined)
    return { verdict: "under", tier, suggest: higher };
  return { verdict: "fit", tier };
}

/**
 * The effort verdict, following the mockup's rule (engine.js:2360-2383).
 * Less effort when a first-try run still spent more than a fifth of its
 * output reasoning; more effort when the run was redone. `fit` names no
 * move: it is also the answer for an effort the ladder does not hold (an
 * Anthropic `xhigh` or `max`) and for a run whose figures were not read,
 * because neither leaves a rung the record can argue for.
 */
function effortFit(input: RunFitInput): RunEffortFit {
  if (input.effort === null || input.effort.trim() === "")
    return {
      verdict: "unseen",
      why: input.proxied ? "not_sent" : "not_proxied",
    };
  const effort = input.effort.trim().slice(0, EFFORT_MAX);
  const source = input.effortSource ?? "harness";
  const { read } = input;
  const rung = rungOf(EFFORT_LADDERS, effort);
  if (read === null || rung === null)
    return { verdict: "fit", effort, source };
  const lower = rung.ladder[rung.rank - 1];
  const higher = rung.ladder[rung.rank + 1];
  const reasoned =
    read.outputTokens !== null &&
    read.reasoningTokens !== null &&
    read.outputTokens > 0 &&
    read.reasoningTokens > REASONING_SHARE_OVER * read.outputTokens;
  if (!redone(read) && reasoned && lower !== undefined)
    return { verdict: "over", effort, source, suggest: lower };
  if (redone(read) && higher !== undefined)
    return { verdict: "under", effort, source, suggest: higher };
  return { verdict: "fit", effort, source };
}

/**
 * The reading for one sealed run. Pure: the caller reads the record and
 * stores the answer with its provenance.
 *
 * The model verdict needs the figures and a class on a known ladder, and is
 * null without either. The effort verdict is never null: with no effort in
 * the record it says why none was seen.
 */
export function runFit(input: RunFitInput): RunFitReading {
  const effort = effortFit(input);
  if (input.read === null) return { read: null, model: null, effort };
  return {
    read: input.read,
    model: modelFit(input.tier, input.read),
    effort,
  };
}
