/**
 * `get_unproductive_spend`: the workspace's unproductive spend over a day
 * range, the one total the Spend page leads with (spend spec, Counting).
 *
 * The headline adds the model-call frames that open and applied findings of
 * detectors 1, 7, and 8 claim, each counted once under the first detector
 * that claims it (counting rule 1, ADR-208). It reads the same claim rows
 * with the same count as `get_operator_ranking`, so for one period the
 * ranking's total equals this headline. Its share divides it by the priced
 * spend of the frames the workspace's runs ran in the period: both sides
 * count a frame by the time it ran.
 *
 * Beside the headline and out of its sum: what detectors 2, 3, and 5 price,
 * each a part of a request (rule 2), and what detector 4 estimates (rule 3).
 * Each figure adds the open and applied findings of the detector's kinds
 * whose window overlaps the period.
 *
 * A period whose figures hold two currencies is refused with `conflict`
 * (`unproductive_mixed_currency`), since each figure sums one currency.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { dayRangeSchema, moneySchema, ratioSchema } from "./spend.shared";

/**
 * The detectors that price a part of a request, with the finding kinds each
 * writes: 2 standing context, 3 cache expiry and busts (including the write
 * premium of a cache no request read), and 5 context carry.
 */
export const UNPRODUCTIVE_PARTS = [
  { detector: 2, kinds: ["standing_context"] },
  {
    detector: 3,
    kinds: ["cache_writes_never_read", "idle_cache_rewrites", "cache_busts"],
  },
  { detector: 5, kinds: ["unpaged_results"] },
] as const;

/** Detector 4, model class fit: a counterfactual on a smaller model class. */
export const UNPRODUCTIVE_ESTIMATE = {
  detector: 4,
  kinds: ["model_class_fit"],
} as const;

const findingFigureSchema = z
  .object({
    /** The findings' savings summed. Zero when none overlaps the period. */
    saving: moneySchema,
    /** The open and applied findings the figure adds. */
    findings: z.number().int().nonnegative(),
  })
  .strict();

export const unproductivePartSchema = findingFigureSchema
  .extend({ detector: z.union([z.literal(2), z.literal(3), z.literal(5)]) })
  .strict();

export const spendUnproductive = registerCapability({
  name: "get_unproductive_spend",
  domain: "spend",
  description:
    "Answer this workspace's unproductive spend over a day range: the frames that spin loops, recurring runs, and spend with no outcome claim, each counted once, and its share of the priced spend of the frames that ran in the period. Beside it and out of its sum: what standing context, cache rewrites, and context carry price, and what model class fit estimates. Equals the operator ranking's total for the same period.",
  mode: "sync",
  surfaces: ["api", "agent"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  // The same people who read the findings the figures come from (list_findings).
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Billing: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  agent: { requiresApproval: false, riskLevel: "low", category: "billing" },
  input: z.object({ period: dayRangeSchema }).strict(),
  output: z
    .object({
      period: z.object({ from: z.string(), to: z.string() }).strict(),
      /** The headline: every claimed frame in the period, counted once (rule 1). */
      unproductive: moneySchema,
      /**
       * The priced spend of the frames the workspace's runs ran in the period.
       * Null when nothing was priced, when it holds another currency, or when
       * a run that crosses the period's edge could not be priced.
       */
      spend: moneySchema.nullable(),
      /** `unproductive` over `spend`, at most 1; null when `spend` is null or zero. */
      share: ratioSchema.nullable(),
      /** Detectors 2, 3, and 5 in that order, each beside the headline and out of it (rule 2). */
      parts: z.array(unproductivePartSchema).length(UNPRODUCTIVE_PARTS.length),
      /** Detector 4's estimate, beside the headline and out of it (rule 3). */
      estimate: findingFigureSchema,
    })
    .strict(),
});

export type SpendUnproductiveInput = z.output<typeof spendUnproductive.input>;
export type SpendUnproductiveOutput = z.output<typeof spendUnproductive.output>;
export type UnproductivePart = z.output<typeof unproductivePartSchema>;
