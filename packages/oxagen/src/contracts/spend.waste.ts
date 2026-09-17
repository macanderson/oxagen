/**
 * `list_waste`: spend the frames show bought nothing, by cause, with the runs
 * that prove it (Mission Control spec §12.8 "Where to optimize"; ADR-060).
 * Each cause is a pattern read off the cost rollup, never a guess: today the
 * one cause the rollup can cost exactly is a cache written and never read.
 * A pattern with a counterfactual saving over the runs it cites is a finding
 * (`list_findings`, ADR-062), not a cause here.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { runPublicIdSchema } from "./run.list";
import { costSchema, dayRangeSchema, ratioSchema } from "./spend.shared";

export const wasteCauseSchema = z.enum(["cache_write_never_read"]);

export const wasteCauseRowSchema = z
  .object({
    cause: wasteCauseSchema,
    wasted: costSchema,
    runs: z.number().int().nonnegative(),
    /** The runs that prove the cause, largest waste first, at most ten. */
    runIds: z.array(runPublicIdSchema).max(10),
  })
  .strict();

export const spendWasteList = registerCapability({
  name: "list_waste",
  domain: "spend",
  description:
    "List this workspace's wasted spend over a day range by cause, each cause a pattern read off the cost rollup with the runs that prove it: the total wasted with its basis, its share of spend, and the largest cause.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Billing: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({ period: dayRangeSchema }).strict(),
  output: z
    .object({
      period: z.object({ from: z.string(), to: z.string() }).strict(),
      /** Null when no run in the period showed waste. */
      wasted: costSchema.nullable(),
      /** Wasted over the period's priced spend; null when either is unpriced. */
      share: ratioSchema.nullable(),
      runsWithWaste: z.number().int().nonnegative(),
      largestCause: wasteCauseSchema.nullable(),
      causes: z.array(wasteCauseRowSchema),
    })
    .strict(),
});

export type SpendWasteListInput = z.output<typeof spendWasteList.input>;
export type SpendWasteListOutput = z.output<typeof spendWasteList.output>;
