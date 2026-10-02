/**
 * `get_work_order_metrics`: the operator metrics, the work order metrics,
 * and unassigned spend, per week (spend spec, Operator productivity; F33).
 *
 * Each week runs Monday 00:00 UTC to the next Monday, and every week that
 * overlaps the day range is reported whole. A week settles a day after it
 * ends: until then a direct work order can still be attached inside its
 * 24-hour grace window and move spend off the unassigned line (decision 4).
 *
 * - A work order is done at its first passing check run of its definition
 *   of done (decision 5). Only a send has a definition of done, so a direct
 *   work order is never done. A person who reopens the work item or returns
 *   the work order after the passing check adds to the reopen rate.
 * - Unassigned spend is spend on runs whose direct work order has no work
 *   item. It is its own line: it never adds to unproductive spend, and the
 *   headline `get_unproductive_spend` answers is unchanged by it
 *   (decision 3). A direct work order attached within 24 hours of its first
 *   run counts as assigned from that run, and one attached later counts as
 *   assigned from the attachment on (decision 4).
 * - Spend and unassigned spend count each frame by the time it ran, as the
 *   operator ranking's shares do. Cost to done, rework spend, and abandoned
 *   spend add whole runs of each work order.
 *
 * Every figure names its metric, whose definition the answer carries in
 * `definitions`, and cites the work orders and runs behind it. The answer
 * names operators, so it has the ranking's org readers: an org Owner or
 * Admin. The ranking also admits the workspace's Owner (#5182); this does not.
 * With the workspace's pseudonym setting on, a pseudonym replaces each name,
 * and the operator rows drop their evidence, both shares, and their
 * unassigned spend, any of which could match a pseudonym to a name.
 *
 * A period whose figures hold two currencies is refused with `conflict`
 * (`work_order_metrics_mixed_currency`).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { runPublicIdSchema } from "./run.list";
import {
  rankedOperatorSchema,
  workOrderPublicIdSchema,
} from "./spend.operator_ranking";
import { dayRangeSchema, daySchema, moneySchema, ratioSchema } from "./spend.shared";

/** At most this many work orders, runs, or agents are cited under one figure. */
export const WORK_ORDER_METRICS_EVIDENCE_MAX = 10;

/** At most this many weeks: a 92-day range touches no more. */
export const WORK_ORDER_METRICS_WEEKS_MAX = 14;

/** Which way a metric should move as an operator's work improves. */
export const metricDirectionSchema = z.enum([
  "up",
  "down",
  "flat_or_down",
  "flat_or_up",
  "context",
]);

export const metricDefinitionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    definition: z.string().min(1),
    direction: metricDirectionSchema,
  })
  .strict();
export type MetricDefinition = z.output<typeof metricDefinitionSchema>;

/**
 * The seven operator metrics (spend spec, Operator metrics). Per operator,
 * per week, over the work orders the operator sent and the direct work
 * orders Oxagen opened for the operator's runs.
 */
export const OPERATOR_METRIC_DEFINITIONS = [
  {
    id: "done_work_orders",
    name: "Done work orders",
    definition:
      "Work orders whose definition of done passed. A work order counts in the week of its first passing check run.",
    direction: "up",
  },
  {
    id: "cost_per_done",
    name: "Cost per done",
    definition:
      "Spend on work orders with a definition of done, divided by done work orders.",
    direction: "down",
  },
  {
    id: "unproductive_share",
    name: "Unproductive share",
    definition:
      "Unproductive spend divided by all spend, each frame counted by the time it ran. This is the guardrail on growth.",
    direction: "flat_or_down",
  },
  {
    id: "agents_in_flight",
    name: "Agents in flight",
    definition:
      "Distinct agents with a run open, averaged over the week. For the current week, the average covers the part of the week that has passed.",
    direction: "context",
  },
  {
    id: "leverage",
    name: "Leverage",
    definition: "Done work orders divided by agents in flight.",
    direction: "flat_or_up",
  },
  {
    id: "touches_per_done",
    name: "Touches per done",
    definition:
      "Interrupts divided by done work orders. Oxagen counts interrupts only: no detector classifies corrective prompts yet.",
    direction: "down",
  },
  {
    id: "unassigned_share",
    name: "Unassigned share",
    definition: "Unassigned spend divided by all spend.",
    direction: "down",
  },
] as const satisfies readonly MetricDefinition[];

/**
 * The seven work order metrics (spend spec, Work order metrics), over the
 * work orders with a definition of done, grouped by operator, agent, and
 * workspace.
 */
export const WORK_ORDER_METRIC_DEFINITIONS = [
  {
    id: "done_rate",
    name: "Done rate",
    definition:
      "Work orders closed in the week whose definition of done passed by the close, divided by work orders closed in the week.",
    direction: "up",
  },
  {
    id: "first_pass_rate",
    name: "First-pass rate",
    definition:
      "Done work orders with no failed check run before the passing one, divided by done work orders.",
    direction: "up",
  },
  {
    id: "cost_to_done",
    name: "Cost to done",
    definition:
      "Spend on every run of a work order that started by its passing check, averaged over done work orders.",
    direction: "down",
  },
  {
    id: "time_to_done",
    name: "Time to done",
    definition:
      "Time from dispatch to the passing check, averaged over done work orders.",
    direction: "down",
  },
  {
    id: "rework_spend",
    name: "Rework spend",
    definition:
      "Spend on runs that started after a failed check run, up to the passing one.",
    direction: "down",
  },
  {
    id: "abandoned_spend",
    name: "Abandoned spend",
    definition:
      "Spend on work orders closed in the week with no passing check run.",
    direction: "down",
  },
  {
    id: "reopen_rate",
    name: "Reopen rate",
    definition:
      "Done work orders whose work item a person reopened, or that a person returned, within 14 days of the passing check, divided by done work orders.",
    direction: "down",
  },
] as const satisfies readonly MetricDefinition[];

/** Unassigned spend (spend spec, Unassigned spend). */
export const UNASSIGNED_SPEND_DEFINITION = {
  id: "unassigned_spend",
  name: "Unassigned spend",
  definition:
    "Spend on runs whose direct work order has no work item. A direct work order attached within 24 hours of its first run counts as assigned from that run. One attached later counts as assigned from the attachment on. Unassigned spend never adds to unproductive spend.",
  direction: "down",
} as const satisfies MetricDefinition;

const evidence = {
  /** The work orders behind the figure, by public id. */
  workOrders: z
    .array(workOrderPublicIdSchema)
    .max(WORK_ORDER_METRICS_EVIDENCE_MAX),
  /** The runs behind the figure. */
  runs: z.array(runPublicIdSchema).max(WORK_ORDER_METRICS_EVIDENCE_MAX),
};

const rateFigureSchema = z
  .object({
    /** `numerator` over `denominator`; null when the denominator is 0. */
    value: ratioSchema.nullable(),
    numerator: z.number().int().nonnegative(),
    denominator: z.number().int().nonnegative(),
    ...evidence,
  })
  .strict();

const moneyFigureSchema = z
  .object({
    /** Null when there is nothing to divide by, or a run is priced in another currency. */
    value: moneySchema.nullable(),
    ...evidence,
  })
  .strict();

export const workOrderMetricsSchema = z
  .object({
    /** Work orders whose first passing check run fell in the week. */
    done: z.number().int().nonnegative(),
    doneRate: rateFigureSchema,
    firstPassRate: rateFigureSchema,
    costToDone: moneyFigureSchema,
    timeToDone: z
      .object({
        /** The mean, in milliseconds; null when nothing was done. */
        valueMs: z.number().int().nonnegative().nullable(),
        ...evidence,
      })
      .strict(),
    reworkSpend: moneyFigureSchema,
    abandonedSpend: moneyFigureSchema,
    reopenRate: rateFigureSchema
      .extend({
        /** Done work orders whose 14-day window has not ended; not yet in either count. */
        pending: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type WorkOrderMetrics = z.output<typeof workOrderMetricsSchema>;

export const unassignedLineSchema = z
  .object({
    /** Null when a run's frames could not be priced, or under pseudonyms. */
    spend: moneySchema.nullable(),
    /** The tokens of the unassigned frames, every class but server tool requests. */
    tokens: z.number().int().nonnegative().nullable(),
    /** `spend` over all spend; null when either is unknown. */
    share: ratioSchema.nullable(),
    /** The runs behind it, largest unassigned part first; empty under pseudonyms. */
    runs: z
      .array(
        z.object({ runId: runPublicIdSchema, unassigned: moneySchema }).strict(),
      )
      .max(WORK_ORDER_METRICS_EVIDENCE_MAX),
  })
  .strict();
export type UnassignedLine = z.output<typeof unassignedLineSchema>;

export const operatorMetricsSchema = z
  .object({
    doneWorkOrders: z
      .object({ value: z.number().int().nonnegative(), ...evidence })
      .strict(),
    costPerDone: moneyFigureSchema,
    unproductiveShare: z
      .object({
        /** Null when spend is unknown or zero, or under pseudonyms. */
        value: ratioSchema.nullable(),
        /** The runs with unproductive frames, largest first. */
        runs: evidence.runs,
      })
      .strict(),
    agentsInFlight: z
      .object({
        value: z.number().nonnegative(),
        /** The agents with a run open in the week (`org_ns.ws_ns.slug`). */
        agents: z.array(z.string().min(1)).max(WORK_ORDER_METRICS_EVIDENCE_MAX),
      })
      .strict(),
    leverage: z
      .object({
        /** Null when no agent was in flight. */
        value: z.number().nonnegative().nullable(),
      })
      .strict(),
    touchesPerDone: z
      .object({
        /** Null when nothing was done. */
        value: z.number().nonnegative().nullable(),
        touches: z.number().int().nonnegative(),
        /** What a touch counts. Interrupts only, until a detector classifies corrective prompts. */
        basis: z.literal("interrupts"),
        /** The runs with an interrupt. */
        runs: evidence.runs,
      })
      .strict(),
    unassignedShare: z
      .object({ value: ratioSchema.nullable(), runs: evidence.runs })
      .strict(),
  })
  .strict();
export type OperatorMetrics = z.output<typeof operatorMetricsSchema>;

export const workOrderMetricsWeekSchema = z
  .object({
    week: z.object({ from: daySchema, to: daySchema }).strict(),
    /** A day has passed since the week ended, so no attachment can still move its spend. */
    settled: z.boolean(),
    workspace: z
      .object({
        /** All spend in the week; null when a run's frames could not be priced. */
        spend: moneySchema.nullable(),
        /** The week's unproductive spend, the headline's count for the week. Unassigned spend is not in it. */
        unproductive: moneySchema,
        unassigned: unassignedLineSchema,
        /** Spend on runs rolled up before work orders were recorded, with no work order yet. */
        notRecorded: moneySchema.nullable(),
        workOrders: workOrderMetricsSchema,
      })
      .strict(),
    /** Every operator with a run or a work order in the week, by key or by pseudonym. */
    operators: z.array(
      z
        .object({
          operator: rankedOperatorSchema,
          metrics: operatorMetricsSchema,
          unassigned: unassignedLineSchema,
          workOrders: workOrderMetricsSchema,
        })
        .strict(),
    ),
    /** Every agent with a run or a work order in the week. */
    agents: z.array(
      z
        .object({
          agentKey: z.string().min(1),
          unassigned: unassignedLineSchema,
          workOrders: workOrderMetricsSchema,
        })
        .strict(),
    ),
  })
  .strict();
export type WorkOrderMetricsWeek = z.output<typeof workOrderMetricsWeekSchema>;

export const spendWorkOrderMetrics = registerCapability({
  name: "get_work_order_metrics",
  domain: "spend",
  description:
    "Report this workspace's operator metrics, work order metrics, and unassigned spend for each week that overlaps a day range. A work order is done at its first passing check run. Unassigned spend is spend on runs whose direct work order has no work item, with a 24-hour grace window, and it is not part of unproductive spend. Each figure cites its definition and the work orders and runs behind it. Org Owner or Admin only.",
  mode: "sync",
  surfaces: ["api", "agent"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  // The operator ranking's org readers: the answer names operators.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  agent: { requiresApproval: false, riskLevel: "low", category: "billing" },
  input: z.object({ period: dayRangeSchema }).strict(),
  output: z
    .object({
      period: z.object({ from: z.string(), to: z.string() }).strict(),
      /** Whether pseudonyms replace the names in this answer. */
      pseudonyms: z.boolean(),
      /** ISO 4217: the one currency every money figure is in. */
      currency: z.string().length(3),
      /** What each figure counts. Every figure is keyed by one of these. */
      definitions: z
        .object({
          operator: z.array(metricDefinitionSchema),
          workOrder: z.array(metricDefinitionSchema),
          unassigned: metricDefinitionSchema,
        })
        .strict(),
      /** Oldest first. */
      weeks: z
        .array(workOrderMetricsWeekSchema)
        .min(1)
        .max(WORK_ORDER_METRICS_WEEKS_MAX),
    })
    .strict(),
});

export type SpendWorkOrderMetricsInput = z.output<
  typeof spendWorkOrderMetrics.input
>;
export type SpendWorkOrderMetricsOutput = z.output<
  typeof spendWorkOrderMetrics.output
>;
