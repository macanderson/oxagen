/**
 * `list_waste`: spend the frames show bought nothing, by cause, with the runs
 * that prove it (Mission Control spec §12.8 "Where to optimize"; ADR-060,
 * ADR-208). Each cause is a pattern the record shows, never a guess. Two
 * sources feed it:
 *
 * - A cache written and never read, read off the cost rollup: the run wrote
 *   prompt-cache tokens and read none back, so every cache write it paid for
 *   bought nothing.
 * - The model calls that open and applied findings of detectors 1, 7, and 8
 *   claim (`cost.finding_claims`), by the time each call ran. A call counts
 *   once, under the first detector that claims it and then the first cause in
 *   {@link WASTE_CLAIM_CAUSES}. These causes sum to the unproductive spend
 *   headline (`get_unproductive_spend`) for the same period.
 *
 * So `wasted` is that headline plus the cache-write cause. A run whose calls
 * a finding claims is left out of the cache-write cause, since the claim
 * already counts each of those calls whole. A finding that prices part of a
 * request, or a counterfactual (detectors 2 to 5), is not a cause here: it
 * stays beside the headline on the Findings tab (`list_findings`, ADR-062).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { RUN_LABEL_MAX, runPublicIdSchema } from "./run.list";
import { costSchema, dayRangeSchema, ratioSchema } from "./spend.shared";

export const wasteCauseSchema = z.enum([
  "cache_write_never_read",
  "spin_loops",
  "retry_loops",
  "repeated_calls",
  "recurring_runs",
  "spend_with_no_outcome",
]);
export type WasteCause = z.infer<typeof wasteCauseSchema>;

/**
 * The causes the claimed calls carry, in counting order, with the finding
 * kinds each one groups:
 *
 * - `spin_loops`: a request in a run of 20 or more identical calls that each
 *   got the same result (detector 1).
 * - `retry_loops`: a request that only retried a call that had already failed
 *   with the same error (detector 1).
 * - `repeated_calls`: a request whose every tool call or shell command
 *   repeated an earlier one in the run with the same input and result
 *   (detector 1).
 * - `recurring_runs`: every call of a scheduled run that changed nothing
 *   (detector 7).
 * - `spend_with_no_outcome`: every call of a run whose work did not land
 *   (detector 8).
 */
export const WASTE_CLAIM_CAUSES = [
  { cause: "spin_loops", detector: 1, kinds: ["spin_loops"] },
  { cause: "retry_loops", detector: 1, kinds: ["retry_loops"] },
  {
    cause: "repeated_calls",
    detector: 1,
    kinds: ["duplicate_tool_calls", "repeated_shell_commands"],
  },
  { cause: "recurring_runs", detector: 7, kinds: ["recurring_runs"] },
  {
    cause: "spend_with_no_outcome",
    detector: 8,
    kinds: ["spend_with_no_outcome"],
  },
] as const satisfies readonly {
  cause: Exclude<WasteCause, "cache_write_never_read">;
  detector: 1 | 7 | 8;
  kinds: readonly string[];
}[];

export const wasteCauseRowSchema = z
  .object({
    cause: wasteCauseSchema,
    wasted: costSchema,
    runs: z.number().int().nonnegative(),
    /** The runs that prove the cause, largest waste first, at most ten. */
    runIds: z.array(runPublicIdSchema).max(10),
    /**
     * The same runs in the same order, each with its session name: the name
     * the Fleet board shows, or null when the run has none (#4571).
     */
    provingRuns: z
      .array(
        z
          .object({
            runId: runPublicIdSchema,
            name: z.string().max(RUN_LABEL_MAX).nullable(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();

export const spendWasteList = registerCapability({
  name: "list_waste",
  domain: "spend",
  description:
    "List this workspace's wasted spend over a day range by cause, with the runs that prove each cause: the model calls open findings claim, which sum to the unproductive spend headline, and the cache writes no call read. Answers the total wasted with its basis, its share of spend, the largest cause, and how many open findings claim calls outside the range.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
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
  agent: { requiresApproval: false, riskLevel: "low", category: "billing" },
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
      /** Largest waste first. */
      causes: z.array(wasteCauseRowSchema),
      /**
       * The open findings of the claiming kinds whose calls all ran outside
       * the period: each claims calls only outside it, or claims none and
       * covers only days outside it. The Findings tab lists them, and no
       * cause here counts their calls.
       */
      findingsOutsidePeriod: z.number().int().nonnegative(),
    })
    .strict(),
});

export type SpendWasteListInput = z.output<typeof spendWasteList.input>;
export type SpendWasteListOutput = z.output<typeof spendWasteList.output>;
