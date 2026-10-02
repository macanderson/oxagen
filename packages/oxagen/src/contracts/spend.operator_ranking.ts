/**
 * `get_operator_ranking`: the workspace's operators ranked by unproductive
 * spend over a day range, highest first (spend spec, Operator ranking; D15).
 * Every figure comes from the frames that open and applied findings claim
 * (ADR-208), counted once each, so the operator totals and the unattributed
 * total sum to the headline that `get_unproductive_spend` answers. Managers
 * read it: an org Owner or Admin, or the workspace's Owner. A workspace's
 * creator holds the workspace Owner role in IAM (#5182), so the kernel admits
 * that Owner in an Enterprise org and the handler admits the same people on
 * every tier. The ranking reports the record and gives no verdict on the
 * person.
 *
 * With the workspace's pseudonym setting on, a stable pseudonym replaces each
 * name and the answer carries no key, no facts, and no run ids, since a run
 * page names its operator. It also carries no unproductive share and no run
 * count: `get_spend` names each operator beside priced spend and runs, and
 * those two figures would match a pseudonym to a name. The unproductive
 * figures and the ranks stay.
 *
 * Beside each name are its done work orders and its unassigned share (F33,
 * spend spec Operator productivity). A work order is done at its first
 * passing check run of its definition of done, in the period that check fell
 * in. The unassigned share is the operator's spend on runs whose direct work
 * order has no work item, with a 24-hour grace window, over the operator's
 * spend, both counted by frame time. Unassigned spend is never part of the
 * unproductive figures. Under pseudonyms the done count stays, and the share
 * and the work orders and runs behind both are dropped.
 *
 * A period whose claims hold two currencies is refused with `conflict`
 * (`ranking_mixed_currency`), since the ranking sums one currency.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { operatorFactsSchema } from "./operator.shared";
import { runPublicIdSchema } from "./run.list";
import { dayRangeSchema, moneySchema, ratioSchema } from "./spend.shared";

/** At most this many runs are cited under one operator, largest first. */
export const OPERATOR_RANKING_RUNS_MAX = 10;

/** A work order's public id (`wo_…`), the id a person reads; never its uuid. */
export const workOrderPublicIdSchema = z
  .string()
  .regex(/^wo_[0-9a-z]+$/, "a work order public id (wo_…)");

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
    /**
     * `unproductive` over the priced spend of the frames this operator's runs
     * ran in the period, counted by frame time as the claims are. Null when
     * nothing was priced, when that spend holds another currency, when a run
     * that crosses the period's edge could not be priced, or under
     * pseudonyms.
     */
    unproductiveShare: ratioSchema.nullable(),
    /** Distinct runs with a claimed frame; null under pseudonyms. */
    runs: z.number().int().positive().nullable(),
    /** The runs behind the figure, largest first; empty under pseudonyms. */
    topRuns: z
      .array(
        z
          .object({ runId: runPublicIdSchema, unproductive: moneySchema })
          .strict(),
      )
      .max(OPERATOR_RANKING_RUNS_MAX),
    /**
     * Work orders the operator sent whose first passing check run of their
     * definition of done fell in the period. Shown under pseudonyms too.
     */
    doneWorkOrders: z.number().int().nonnegative(),
    /** The done work orders behind the figure, oldest pass first, each with its runs; empty under pseudonyms. */
    topDoneWorkOrders: z
      .array(
        z
          .object({
            workOrderId: workOrderPublicIdSchema,
            /** When its first passing check run finished. */
            doneAt: z.string().datetime(),
            runs: z.array(runPublicIdSchema).max(OPERATOR_RANKING_RUNS_MAX),
          })
          .strict(),
      )
      .max(OPERATOR_RANKING_RUNS_MAX),
    /**
     * The operator's unassigned spend over the operator's spend, both by
     * frame time. Null when nothing was priced, when a run could not be
     * priced, when the spend holds another currency, or under pseudonyms.
     */
    unassignedShare: ratioSchema.nullable(),
    /** The runs behind the share, largest unassigned part first; empty under pseudonyms. */
    topUnassignedRuns: z
      .array(
        z
          .object({ runId: runPublicIdSchema, unassigned: moneySchema })
          .strict(),
      )
      .max(OPERATOR_RANKING_RUNS_MAX),
  })
  .strict();

export const spendOperatorRanking = registerCapability({
  name: "get_operator_ranking",
  domain: "spend",
  description:
    "Rank this workspace's operators by unproductive spend over a day range, highest first: each operator's unproductive spend, its share of the headline, its share of the priced spend of the frames the operator's runs ran in the period, its run count, its done work orders, its unassigned share, and the runs and work orders behind them. Only an org Owner or Admin, or the workspace's Owner, may read it. The operator totals and the unattributed total sum to the headline get_unproductive_spend answers, and unassigned spend is not part of it.",
  mode: "sync",
  surfaces: ["api", "agent"],
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
  agent: { requiresApproval: false, riskLevel: "low", category: "billing" },
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
