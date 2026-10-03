/**
 * `get_spend_drill`: one operator, agent or tool over a trailing window
 * (Mission Control spec §12.9 "Operator view", "Agent view"; ADR-060). Reads
 * the run rows (`cost.run_totals`) the key attributes to, in the active
 * workspace: the daily series, the averages per call and per run, the share
 * of the workspace's spend over the window, the tokens by class with their
 * cache hit rate, the standing context the calls carried, the tools those
 * runs called, and the key's spend split by agent, operator and model.
 *
 * No frame prices a tool call (spec §12.3, "with a declared price"), so a
 * tool drill's money is what the tool's results cost as input to the calls
 * that read them: each run's result tokens for the tool at that run's
 * uncached input rate (ADR-199), with the `estimated` basis. The runs already
 * paid that input, so it is a part of their cost and never money on top of
 * it. Its share of the workspace is null, since the part is an estimate.
 */
import { z } from "zod";
import { operatorFactsSchema } from "./operator.shared";
import { registerCapability } from "../registry";
import {
  costSchema,
  daySchema,
  moneySchema,
  principalPublicIdSchema,
  ratioSchema,
  SPEND_RANGE_DAYS_MAX,
  spendDaySchema,
  spendFigureSchema,
  standingTokensSchema,
  tokenCountsSchema,
  unmeteredRunsSchema,
} from "./spend.shared";

export const drillKindSchema = z.enum(["operator", "agent", "tool"]);

const countSchema = z.number().int().nonnegative();

/**
 * One row of a cross-cut: the part of the key's figure that one agent, one
 * operator or one model holds. On an operator or agent drill a row's cost,
 * calls and tokens are its runs' own, and a model row's are that model's
 * calls in the key's runs. On a tool drill a row's cost, calls and result
 * tokens are the tool's in those runs, and its tokens are the runs'.
 */
export const drillCutRowSchema = z
  .object({
    /** The agent key, the operator's principal public id, or the model id. */
    key: z.string(),
    /** The model's provider on a model row; null elsewhere. */
    provider: z.string().nullable(),
    /** Who an operator row names; null elsewhere and for a principal nobody can name. */
    operator: operatorFactsSchema.nullable(),
    runs: countSchema,
    calls: countSchema,
    /** Null when nothing in the row priced. */
    cost: costSchema.nullable(),
    tokens: tokenCountsSchema,
    /** The tool's result tokens on a tool drill; null elsewhere and when none recorded. */
    resultTokens: countSchema.nullable(),
  })
  .strict();
export type DrillCutRow = z.output<typeof drillCutRowSchema>;

export const DRILL_DAYS_DEFAULT = 30;
export const DRILL_DAYS_MAX = SPEND_RANGE_DAYS_MAX;

/**
 * The input's fields. Exported on their own because the registered `input`
 * is a ZodEffects (the key rule below) and has no `.shape`; the MCP tool
 * builds its parameter schema from this object and `invoke()` parses the
 * refined input on every surface.
 */
export const spendDrillInputObject = z
  .object({
    kind: drillKindSchema,
    /** The operator's principal public id (`prn_…`), the agent key, or the tool name. */
    key: z.string().min(1).max(256),
    /** Trailing window ending today, in days. */
    days: z
      .number()
      .int()
      .min(1)
      .max(DRILL_DAYS_MAX)
      .default(DRILL_DAYS_DEFAULT),
  })
  .strict();

export const spendDrill = registerCapability({
  name: "get_spend_drill",
  domain: "spend",
  description:
    "Read one operator, agent or tool's spend over a trailing window in this workspace: the daily series, the average per call and per run, its share of the workspace's spend, its tokens by class with the cache hit rate, the tools its runs called, and its spend split by agent, operator and model, every figure in micros with its basis. A tool's spend is what its results cost as input to later calls, an estimate its runs already paid.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  agent: { requiresApproval: false, riskLevel: "low", category: "billing" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Billing: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  // An operator key is the principal's public id, the id `list_runs` answers
  // as `operatorId` and `get_spend` answers as an operator row's `key`; the
  // store filters on that column, so any other string is refused here.
  input: spendDrillInputObject.superRefine((value, ctx) => {
    if (value.kind !== "operator") return;
    const key = principalPublicIdSchema.safeParse(value.key);
    if (key.success) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["key"],
      message: "an operator key is a principal public id (prn_…)",
    });
  }),
  output: z
    .object({
      kind: drillKindSchema,
      key: z.string(),
      period: z.object({ from: daySchema, to: daySchema }).strict(),
      /**
       * The key's runs over the window. On a tool drill, `calls` counts the
       * tool's own calls and `cost` is its results' estimated input cost.
       */
      total: spendFigureSchema,
      /** One entry per day of the window, oldest first, days with no run included. */
      series: z.array(spendDaySchema),
      averages: z
        .object({
          perCall: moneySchema.nullable(),
          perRun: moneySchema.nullable(),
        })
        .strict(),
      /**
       * The key's spend over the workspace's spend in the window; null when
       * neither is priced, and always null on a tool drill.
       */
      share: ratioSchema.nullable(),
      /**
       * The key's runs' tokens by class. On a tool drill, the tokens of the
       * runs that called the tool, which the tool does not own.
       */
      tokens: tokenCountsSchema,
      /**
       * cache_read ÷ (input_uncached + cache_read) over `tokens`,
       * token-weighted: the ratio the Spend page's Tokens tile prints. Null
       * when the runs read no input token.
       */
      cacheHitRate: ratioSchema.nullable(),
      /** The model calls the key's runs made; `total.calls` counts tool calls too. */
      modelCalls: countSchema,
      /**
       * The part of `total.cost` the gateway metered: every model whose
       * priced frames were all `gateway_observed`. A model with `mixed` or
       * `estimated` frames counts as not observed, so this is a floor. Null
       * when no such model carries a cost, and always null on a tool drill.
       */
      observed: moneySchema.nullable(),
      /** The standing context the key's model calls carried, by source. */
      standing: standingTokensSchema,
      /**
       * The tool-result tokens the key's runs recorded: the tool's own on a
       * tool drill, every tool's on another. Null when no call recorded any.
       */
      resultTokens: countSchema.nullable(),
      /** The tools the key's runs called, most calls first. */
      byTool: z.array(
        z
          .object({
            name: z.string(),
            calls: countSchema,
            runs: countSchema,
            /** The tool's result tokens in these runs; null when none recorded. */
            resultTokens: countSchema.nullable(),
            /**
             * Those result tokens at each run's uncached input rate, with the
             * `estimated` basis: input the runs already paid. Null when no run
             * priced them.
             */
            cost: costSchema.nullable(),
          })
          .strict(),
      ),
      /**
       * The key's figure split by the agent its runs ran as, costliest first.
       * A run with no agent is in no row.
       */
      byAgent: z.array(drillCutRowSchema),
      /**
       * The key's figure split by the operator who ran its runs, costliest
       * first. A run with no operator is in no row.
       */
      byOperator: z.array(drillCutRowSchema),
      /**
       * The key's runs' spend split by model, costliest first. Empty on a
       * tool drill, whose money is no model's.
       */
      byModel: z.array(drillCutRowSchema),
      /** The key's runs in the window that recorded no usage, by harness. */
      unmeteredRuns: unmeteredRunsSchema.optional(),
    })
    .strict(),
});

export type SpendDrillInput = z.output<typeof spendDrill.input>;
export type SpendDrillOutput = z.output<typeof spendDrill.output>;
