/**
 * `get_spend_drill`: one operator, agent or tool over a trailing window
 * (Mission Control spec §12.9 "Operator view", "Agent view"; ADR-060). Reads
 * the run rows (`cost.run_totals`) the key attributes to, in the active
 * workspace: the daily series, the averages per call and per run, the share
 * of the workspace's spend over the window, and the tools those runs called.
 *
 * A tool drill carries counts and no money: no frame prices a tool call
 * (spec §12.3, "with a declared price"), so its series and averages answer
 * null rather than a share of the run.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  costSchema,
  daySchema,
  moneySchema,
  principalPublicIdSchema,
  ratioSchema,
  SPEND_RANGE_DAYS_MAX,
  spendFigureSchema,
  unmeteredRunsSchema,
} from "./spend.shared";

export const drillKindSchema = z.enum(["operator", "agent", "tool"]);

export const drillDaySchema = z
  .object({
    day: daySchema,
    cost: costSchema.nullable(),
    calls: z.number().int().nonnegative(),
    runs: z.number().int().nonnegative(),
  })
  .strict();

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
    "Read one operator, agent or tool's spend over a trailing window in this workspace: the daily series, the average per call and per run, its share of the workspace's spend, and the tools its runs called, every figure in micros with its basis.",
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
      total: spendFigureSchema,
      /** One entry per day of the window, oldest first, days with no run included. */
      series: z.array(drillDaySchema),
      averages: z
        .object({
          perCall: moneySchema.nullable(),
          perRun: moneySchema.nullable(),
        })
        .strict(),
      /** The key's spend over the workspace's spend in the window; null when neither is priced. */
      share: ratioSchema.nullable(),
      /** The tools the key's runs called, most calls first. */
      byTool: z.array(
        z
          .object({
            name: z.string(),
            calls: z.number().int().nonnegative(),
            runs: z.number().int().nonnegative(),
          })
          .strict(),
      ),
      /** The key's runs in the window that recorded no usage, by harness. */
      unmeteredRuns: unmeteredRunsSchema.optional(),
    })
    .strict(),
});

export type SpendDrillInput = z.output<typeof spendDrill.input>;
export type SpendDrillOutput = z.output<typeof spendDrill.output>;
