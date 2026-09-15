/**
 * `get_run_cost`: the Run page's cost strip and Cost tab (Mission Control
 * spec §12.6, §12.7 "Run" row; ADR-058): the run's `cost.run_totals` row.
 * Answers `rollup: null` until the rollup job has rebuilt the run from its
 * frames after its seal; the page renders that slice as not recorded rather
 * than a zero.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { runPublicIdSchema } from "./run.list";
import { costSchema, ratioSchema, tokenCountsSchema } from "./spend.shared";

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
          cost: costSchema,
          tokens: tokenCountsSchema,
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
  })
  .strict();

export const runCostGet = registerCapability({
  name: "get_run_cost",
  domain: "run",
  description:
    "Read one run's cost rollup: total cost with its basis, tokens by class, cache hit rate, turns, steps, model and tool calls, and the per-model and per-tool breakdown; null until the rollup has rebuilt the run from its frames.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
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
    })
    .strict(),
});

export type RunCostGetInput = z.output<typeof runCostGet.input>;
export type RunCostGetOutput = z.output<typeof runCostGet.output>;
export type RunCostRollup = z.output<typeof runCostRollupSchema>;
