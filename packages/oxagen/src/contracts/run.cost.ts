/**
 * `get_run_cost`: the Run page's cost strip and Cost tab (Mission Control
 * spec §12.6, §12.7 "Run" row; ADR-060): the run's `cost.run_totals` row.
 * The row is rebuilt as the run records frames and again at its seal
 * (#3980). While it was built from an open run, `isEstimate` is true: the
 * figure covers the frames recorded so far and the run may add more.
 * Answers `rollup: null` until the rollup job has built a row at all; the
 * page renders that slice as not recorded rather than a zero.
 *
 * A wrapped run the rollup has not reached yet carries `provisional`: the
 * per-model call counts and reported cost that ingest has folded from the
 * run's `llm_call` frames so far. It is superseded by `rollup` once the rollup
 * rebuilds the run, and the page labels it provisional.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { runPublicIdSchema } from "./run.list";
import { costSchema, ratioSchema, tokenCountsSchema } from "./spend.shared";

/**
 * A model's recorded cost split by the six token classes the rollup prices,
 * each priced from the price book at its frame's instant and rounded once.
 * A class no entry priced is a zero figure; an estimated frame's reported
 * figure, which has no split, sits under `output`.
 */
export const runCostByClassSchema = z
  .object({
    input_uncached: costSchema,
    cache_read: costSchema,
    cache_write_5m: costSchema,
    cache_write_1h: costSchema,
    output: costSchema,
    reasoning: costSchema,
  })
  .strict();

export const runCostRollupSchema = z
  .object({
    /** Null when no model frame was priced. */
    cost: costSchema.nullable(),
    tokens: tokenCountsSchema,
    /** cache_read ÷ (input_uncached + cache_read), spend-weighted; null without input tokens. */
    cacheHitRate: ratioSchema.nullable(),
    turns: z.number().int().nonnegative().nullable(),
    steps: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    retries: z.number().int().nonnegative().nullable(),
    productiveRatio: ratioSchema.nullable(),
    byModel: z.array(
      z
        .object({
          model: z.string(),
          provider: z.string().nullable(),
          calls: z.number().int().nonnegative(),
          /** Null when no frame of the model was priced. */
          cost: costSchema.nullable(),
          tokens: tokenCountsSchema,
          /** `cost` by token class; null exactly when `cost` is. */
          costByClass: runCostByClassSchema.nullable(),
          /**
           * What the model's cache reads saved: cache_read tokens priced at
           * input_uncached less their cache_read price, at each frame's
           * instant. Null when a frame that read the cache had no price for
           * either class, when no frame of the model was priced, and on a
           * row rolled up before the saving was recorded (until its next
           * rollup). Never a zero standing in for "not recorded".
           */
          cacheSaving: costSchema.nullable(),
          /**
           * True when any call to the model went unpriced, including a model
           * where another call did price and `cost` is therefore non-null.
           */
          hasUnpriced: z.boolean(),
        })
        .strict(),
    ),
    byTool: z.array(
      z
        .object({
          name: z.string(),
          calls: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    /** The price entries the frames were priced with (spec §12.2). */
    priceEntryIds: z.array(z.string()),
    /** RFC 3339: when the row was last rebuilt from the frames. */
    rolledUpAt: z.string().datetime(),
    /**
     * True when the row was rebuilt while the run was open: every figure here
     * is a running estimate over the frames recorded so far. False once the
     * rollup has rebuilt the run after its seal.
     */
    isEstimate: z.boolean(),
  })
  .strict();

/**
 * The running figures ingest keeps for a wrapped run (`tacho.session_models`
 * and the session's tool-call counter). Priced from the frames' reported cost,
 * not from the price book, so it can differ from the rollup that replaces it.
 */
export const runCostProvisionalSchema = z
  .object({
    byModel: z.array(
      z
        .object({
          model: z.string(),
          provider: z.string().nullable(),
          calls: z.number().int().nonnegative(),
          /** Null when no call of the model reported a cost. */
          cost: costSchema.nullable(),
        })
        .strict(),
    ),
    toolCalls: z.number().int().nonnegative(),
    /** RFC 3339: the run's last recorded event, which these figures include. */
    asOf: z.string().datetime(),
  })
  .strict();

export const runCostGet = registerCapability({
  name: "get_run_cost",
  domain: "run",
  description:
    "Read one run's cost rollup: total cost with its basis, tokens by class, cache hit rate, turns, steps, model and tool calls, and the per-model breakdown (cost by token class, cache saving, whether any call went unpriced) and per-tool breakdown, marked as an estimate while the run is still open; null until the rollup has rebuilt the run from its frames, with provisional per-model figures for a wrapped run in the meantime.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  agent: { requiresApproval: false, riskLevel: "low", category: "run" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Billing: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({ runId: runPublicIdSchema }).strict(),
  output: z
    .object({
      runId: runPublicIdSchema,
      rollup: runCostRollupSchema.nullable(),
      /** Present only while `rollup` is null and the run is a wrapped session. */
      provisional: runCostProvisionalSchema.nullable().optional(),
    })
    .strict(),
});

export type RunCostGetInput = z.output<typeof runCostGet.input>;
export type RunCostGetOutput = z.output<typeof runCostGet.output>;
export type RunCostRollup = z.output<typeof runCostRollupSchema>;
export type RunCostProvisional = z.output<typeof runCostProvisionalSchema>;
export type RunCostByClass = z.output<typeof runCostByClassSchema>;
