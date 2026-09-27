/**
 * `get_operator_ranking`: the workspace's operators ranked by unproductive
 * spend over a day range, highest first (spend spec, Operator ranking; D15).
 * Every figure comes from the frames that open and applied findings claim
 * (ADR-208), counted once each, so the operator totals and the unattributed
 * total sum to the headline. Managers read it: an org Owner or Admin, or the
 * workspace's Owner. The ranking reports the record and gives no verdict on
 * the person.
 *
 * With the workspace's pseudonym setting on, a stable pseudonym replaces each
 * name and the answer carries no key, no facts, and no run ids, since a run
 * page names its operator. The figures stay.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { operatorFactsSchema } from "./operator.shared";
import { runPublicIdSchema } from "./run.list";
import { dayRangeSchema, moneySchema, ratioSchema } from "./spend.shared";

/** At most this many runs are cited under one operator, largest first. */
export const OPERATOR_RANKING_RUNS_MAX = 10;

/** `Operator` and eight hex digits, stable for one operator in one workspace. */
export const operatorPseudonymSchema = z
  .string()
  .regex(/^Operator [0-9A-F]{8}$/, "Operator and eight hex digits");

export const rankedOperatorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("named"),
      /** The principal public id (`prn_…`) the run record keys the operator by. */
      key: z.string().min(1),
      /** Null when the record holds nothing for the principal. */
      facts: operatorFactsSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pseudonym"),
      pseudonym: operatorPseudonymSchema,
    })
    .strict(),
]);

export const operatorRankingRowSchema = z
  .object({
    /** 1 for the operator with the most unproductive spend. */
    rank: z.number().int().positive(),
    operator: rankedOperatorSchema,
    /** The claimed frames of this operator's runs, each counted once. */
    unproductive: moneySchema,
    /** `unproductive` over the headline. */
    shareOfTotal: ratioSchema,
    /** `unproductive` over this operator's priced spend in the period; null when nothing was priced. */
    unproductiveShare: ratioSchema.nullable(),
    /** Distinct runs with a claimed frame. */
    runs: z.number().int().positive(),
    /** The runs behind the figure, largest first; empty under pseudonyms. */
    topRuns: z
      .array(
        z
          .object({ runId: runPublicIdSchema, unproductive: moneySchema })
          .strict(),
      )
      .max(OPERATOR_RANKING_RUNS_MAX),
  })
  .strict();

export const spendOperatorRanking = registerCapability({
  name: "get_operator_ranking",
  domain: "spend",
  description:
    "Rank this workspace's operators by unproductive spend over a day range, highest first: each operator's unproductive spend, its share of the headline, its share of the operator's priced spend, its run count, and the runs behind it. Managers only. The operator totals and the unattributed total sum to the headline.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({ period: dayRangeSchema }).strict(),
  output: z
    .object({
      period: z.object({ from: z.string(), to: z.string() }).strict(),
      /** Whether pseudonyms replace the names in this answer. */
      pseudonyms: z.boolean(),
      /** The headline: every claimed frame in the period, counted once. */
      unproductive: moneySchema,
      /** The claimed frames of runs that name no operator. */
      unattributed: z
        .object({
          unproductive: moneySchema,
          runs: z.number().int().nonnegative(),
        })
        .strict(),
      /** Largest first. */
      operators: z.array(operatorRankingRowSchema),
    })
    .strict(),
});

export type SpendOperatorRankingInput = z.output<
  typeof spendOperatorRanking.input
>;
export type SpendOperatorRankingOutput = z.output<
  typeof spendOperatorRanking.output
>;
export type OperatorRankingRow = z.output<typeof operatorRankingRowSchema>;
