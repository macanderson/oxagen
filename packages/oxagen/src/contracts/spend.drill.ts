/**
 * `get_spend_drill`: one operator, agent or tool over a trailing window
 * (Mission Control spec §12.9 "Operator view", "Agent view"; ADR-058). Reads
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
  ratioSchema,
  spendFigureSchema,
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
export const DRILL_DAYS_MAX = 92;

export const spendDrill = registerCapability({
  name: "get_spend_drill",
  domain: "spend",
  description:
    "Read one operator, agent or tool's spend over a trailing window in this workspace: the daily series, the average per call and per run, its share of the workspace's spend, and the tools its runs called, every figure in micros with its basis.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
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
  input: z
    .object({
      kind: drillKindSchema,
      /** The operator's principal id, the agent key, or the tool name. */
      key: z.string().min(1).max(256),
      /** Trailing window ending today, in days. */
      days: z
        .number()
        .int()
        .min(1)
        .max(DRILL_DAYS_MAX)
        .default(DRILL_DAYS_DEFAULT),
    })
    .strict(),
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
    })
    .strict(),
});

export type SpendDrillInput = z.output<typeof spendDrill.input>;
export type SpendDrillOutput = z.output<typeof spendDrill.output>;
