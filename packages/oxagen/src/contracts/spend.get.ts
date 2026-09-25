/**
 * `get_spend`: the Spend page's rollup at one level (Mission Control spec
 * §12.7, §12.9, App. E; ADR-060). Reads `cost.daily_totals` for the active
 * workspace over an inclusive day range, grouped by operator, agent, model,
 * tool or task, and answers the rows with the period's total: the month strip.
 *
 * Every money figure is integer micros with a currency and a basis (INV-09);
 * a group no frame priced answers `cost: null`. Proven and accepted spend are
 * never folded together (spec §12.8) and stay null until a verdict lane
 * writes one. A console read is never a governed action (`noBillingGate`).
 */
import { z } from "zod";
import { operatorFactsSchema } from "./operator.shared";
import { registerCapability } from "../registry";
import {
  dayRangeSchema,
  spendFigureSchema,
  spendGroupKindSchema,
  tokenCountsSchema,
} from "./spend.shared";

export const spendRowSchema = spendFigureSchema
  .extend({
    /** The group's key: a principal id, an agent key, a model id, a tool name or a task reference. */
    key: z.string(),
    /** The model's provider on `model` rows; null elsewhere. */
    provider: z.string().nullable(),
    tokens: tokenCountsSchema,
    /** Who the key names on `operator` rows; null elsewhere, and for a principal nobody can name. */
    operator: operatorFactsSchema.nullable(),
  })
  .strict();

export const spendGet = registerCapability({
  name: "get_spend",
  domain: "spend",
  description:
    "Read this workspace's spend over a day range, rolled up by operator, agent, model, tool or task from the cost rollup, with every figure in micros and the basis that says who observed it, plus the period total with proven and accepted spend kept apart.",
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
  input: z
    .object({
      period: dayRangeSchema,
      groupBy: spendGroupKindSchema,
    })
    .strict(),
  output: z
    .object({
      period: z.object({ from: z.string(), to: z.string() }).strict(),
      groupBy: spendGroupKindSchema,
      /** The period over every group: the strip at the top of the page. */
      total: spendFigureSchema,
      /**
       * Priced runs in the period that were still open when their rollup was
       * last built (#3980). Their cost is in every figure here as a running
       * estimate over the calls recorded so far, and grows until they seal.
       */
      estimatedRuns: z.number().int().nonnegative().optional(),
      /** Largest spend first; groups with no cost after those with one. */
      rows: z.array(spendRowSchema),
    })
    .strict(),
});

export type SpendGetInput = z.output<typeof spendGet.input>;
export type SpendGetOutput = z.output<typeof spendGet.output>;
export type SpendRow = z.output<typeof spendRowSchema>;
