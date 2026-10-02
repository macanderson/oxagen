/**
 * `get_spend_per_merged_pr`: what each agent spent per pull request that
 * landed, over a day range (spend spec, detector 8, its first lever; F26).
 *
 * The figure covers bounded runs only. Until work orders mark a bounded task
 * (F13), a bounded run is a run that opened a pull request. Per agent, the
 * figure is the spend on its bounded runs that started in the period, divided
 * by the distinct pull requests those runs opened that merged and were not
 * reverted within 14 days of the merge. An agent with no merged pull request
 * has no figure, never a zero, and says why in `absence`. The pure fold is
 * `spendPerMergedPr` in packages/billing.
 *
 * Anyone who may read `get_spend` may read this: it names agents and runs the
 * Month tab already names.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { runPublicIdSchema } from "./run.list";
import { costSchema, dayRangeSchema } from "./spend.shared";

/** At most this many runs are listed under one agent, costliest first. */
export const SPEND_PER_MERGED_PR_RUNS_MAX = 10;

/** What one pull request became. Only `merged` counts toward the figure. */
export const perMergedPrStateSchema = z.enum([
  "merged",
  "reverted",
  "closed",
  "open",
  "unread",
]);

/** Why an agent has no figure. */
export const perMergedPrAbsenceSchema = z.enum([
  "no_merged_pr",
  "mixed_currency",
  "not_priced",
]);

export const perMergedPrRunSchema = z
  .object({
    runId: runPublicIdSchema,
    startedAt: z.string().datetime(),
    /** Null when the rollup priced no model call of the run. */
    cost: costSchema.nullable(),
    pullRequests: z.array(
      z
        .object({
          /** `github:owner/repo#N`. */
          prKey: z.string().min(1),
          url: z.string().nullable(),
          state: perMergedPrStateSchema,
        })
        .strict(),
    ),
  })
  .strict();

export const perMergedPrAgentSchema = z
  .object({
    /** The agent's key (`org_ns.ws_ns.slug`), the key of its `get_spend` agent row. */
    agentKey: z.string().min(1),
    /** Runs that started in the period and opened at least one pull request. */
    boundedRuns: z.number().int().positive(),
    /** Bounded runs the rollup priced nothing for; their spend is not in `spend`. */
    unpricedRuns: z.number().int().nonnegative(),
    /** Spend on the priced bounded runs; null when the runs hold no single figure. */
    spend: costSchema.nullable(),
    /** Distinct pull requests those runs opened that merged and were not reverted within 14 days. */
    mergedPrs: z.number().int().nonnegative(),
    /** `spend` over `mergedPrs`; null when `absence` says why. */
    perMergedPr: costSchema.nullable(),
    absence: perMergedPrAbsenceSchema.nullable(),
    /** The costliest bounded runs. */
    runs: z.array(perMergedPrRunSchema).max(SPEND_PER_MERGED_PR_RUNS_MAX),
  })
  .strict()
  .refine((a) => (a.perMergedPr === null) === (a.absence !== null), {
    message: "perMergedPr is null exactly when absence is set",
    path: ["absence"],
  });

export const spendPerMergedPr = registerCapability({
  name: "get_spend_per_merged_pr",
  domain: "spend",
  description:
    "Read what each agent in this workspace spent per merged pull request over a day range: the spend on runs that opened a pull request, divided by the pull requests those runs opened that merged and were not reverted within 14 days. An agent with no merged pull request has no figure and says why.",
  mode: "sync",
  surfaces: ["api", "agent"],
  layers: ["schema", "api", "unit", "docs", "app"],
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
  input: z.object({ period: dayRangeSchema }).strict(),
  output: z
    .object({
      period: z.object({ from: z.string(), to: z.string() }).strict(),
      /** One entry per agent with a bounded run in the period, in key order. */
      agents: z.array(perMergedPrAgentSchema),
    })
    .strict(),
});

export type SpendPerMergedPrInput = z.output<typeof spendPerMergedPr.input>;
export type SpendPerMergedPrOutput = z.output<typeof spendPerMergedPr.output>;
export type PerMergedPrAgent = z.output<typeof perMergedPrAgentSchema>;
