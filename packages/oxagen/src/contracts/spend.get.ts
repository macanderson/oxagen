/**
 * `get_spend`: the Spend page's rollup at one level (Mission Control spec
 * §12.7, §12.9, App. E; ADR-060). Reads `cost.daily_totals` for the active
 * workspace over an inclusive day range, grouped by operator, agent, model,
 * tool, task or cost center, and answers the rows with the period's total,
 * its spend by day, and each row's costliest runs: the Month tab.
 *
 * `mcp_server` is the one grouping the daily rollup does not store. The
 * handler folds it from the period's run rows: each server row is what its
 * tools' results cost as input (the ADR-199 estimate), and the
 * {@link OTHER_SPEND_KEY} row is the rest of every run's cost, so the rows
 * sum to the total.
 *
 * `work_item` is folded from the run rows too: each run lands on the work
 * item its work order served, or on the {@link NO_WORK_ITEM_KEY} row, so the
 * rows sum to the total (#2962).
 *
 * The in-app assistant's spend is one row of its own in every grouping, the
 * {@link ASSISTANT_SPEND_KEY} row, and the other rows leave it out (ADR-235,
 * 2026-10-02 amendment). The total, the days, and the reported spend still
 * count it, so the rows sum to the total. That row names no run.
 *
 * Every money figure is integer micros with a currency and a basis (INV-09);
 * a group no frame priced answers `cost: null`. Proven and accepted spend are
 * never folded together (spec §12.8) and stay null until a verdict lane
 * writes one. A console read is never a governed action (`noBillingGate`).
 */
import { z } from "zod";
import { operatorFactsSchema } from "./operator.shared";
import { registerCapability } from "../registry";
import { RUN_LABEL_MAX, runPublicIdSchema } from "./run.list";
import {
  costSchema,
  dayRangeSchema,
  moneySchema,
  spendDaySchema,
  spendFigureSchema,
  standingTokensSchema,
  tokenCountsSchema,
  unmeteredRunsSchema,
} from "./spend.shared";

/**
 * The groupings `get_spend` answers: every level in `spendGroupKindSchema`,
 * which the daily rollup stores, plus `mcp_server` and `work_item`, which it
 * does not.
 */
export const spendGroupBySchema = z.enum([
  "operator",
  "agent",
  "model",
  "tool",
  "task",
  "cost_center",
  "mcp_server",
  "work_item",
]);

/**
 * The `work_item` row key of the runs that served no work item: a run with
 * no work order, as a terminal session started outside Oxagen has until the
 * rollup opens one, and a run whose direct work order nobody has attached to
 * a work item. A work item's key is its public id (`wi_…`), so none collides
 * with it.
 */
export const NO_WORK_ITEM_KEY = "~no_work_item";

/** The work item a `work_item` row names. */
export const spendWorkItemSchema = z
  .object({
    /** The work item's public id (`wi_…`): the row's key. */
    id: z.string().regex(/^wi_[0-9A-Za-z]+$/),
    /** The number people say out loud, such as `OPS-88`. */
    number: z.string().min(1),
    subject: z.string(),
  })
  .strict();
export type SpendWorkItem = z.output<typeof spendWorkItemSchema>;

/**
 * The `mcp_server` row key of the spend no MCP server's tool results carried:
 * model output, the harness's prompt, and every other input. A harness
 * spells a server in a tool name (`mcp__<server>__<tool>`) with letters,
 * digits, `_` and `-`, so no server key collides with it.
 */
export const OTHER_SPEND_KEY = "~other";

/**
 * The row key of the in-app assistant's spend, in every grouping. Oxagen runs
 * the assistant, and the workspace does not monitor it (ADR-235), so the row
 * lists no runs and opens no drill. No principal id, agent key, model id,
 * tool name, task reference, cost-center label, or MCP server name starts
 * with `~`, so no other key collides with it.
 */
export const ASSISTANT_SPEND_KEY = "~oxagen_assistant";

/** The most runs a row lists. */
export const SPEND_TOP_RUNS_MAX = 8;

/** One of a row's costliest runs, with the row's share of its cost. */
export const spendTopRunSchema = z
  .object({
    runId: runPublicIdSchema,
    /** The session name the Fleet board shows; null when the run has none. */
    name: z.string().max(RUN_LABEL_MAX).nullable(),
    startedAt: z.string().datetime(),
    agentKey: z.string().nullable(),
    harness: z.string().nullable().optional(),
    /** The operator's principal public id; null for a run with no operator. */
    operatorKey: z.string().nullable(),
    /**
     * Who `operatorKey` names, so a run line prints a name and never the id.
     * Null for a run with no operator and for a principal nobody can name.
     * Absent from an answer built before it was read.
     */
    operator: operatorFactsSchema.nullable().optional(),
    /**
     * The row's part of the run's cost: the whole run on an operator, agent,
     * task or cost-center row, the model's calls on a model row, and the
     * server's tool results on an `mcp_server` row. Null when nothing priced
     * it, and always null on a tool row, since no frame prices a tool call.
     */
    cost: costSchema.nullable(),
    /** The row's calls in the run: its steps, model calls, or tool calls. */
    calls: z.number().int().nonnegative(),
  })
  .strict();

/**
 * What a row's runs spent on each prompt source the recorder measures,
 * summed over the period's runs (#5295): tool definitions, context frames and
 * steering from `cost.run_totals`, and tool results from each run's
 * breakdown. A source no run of the row measured is null, never a zero. Each
 * is an estimate the row's `tokens` already count.
 */
export const spendTokenSourcesSchema = z
  .object({
    toolDefinitionTokens: z.number().int().nonnegative().nullable(),
    contextFrameTokens: z.number().int().nonnegative().nullable(),
    steeringTokens: z.number().int().nonnegative().nullable(),
    toolResultTokens: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const spendRowSchema = spendFigureSchema
  .extend({
    /**
     * The group's key: a principal id, an agent key, a model id, a tool name,
     * a task reference, a cost-center label, an MCP server name, a work item's
     * public id, {@link OTHER_SPEND_KEY}, {@link NO_WORK_ITEM_KEY}, or
     * {@link ASSISTANT_SPEND_KEY}.
     */
    key: z.string(),
    /** The model's provider on `model` rows; null elsewhere, and on the {@link ASSISTANT_SPEND_KEY} row. */
    provider: z.string().nullable(),
    tokens: tokenCountsSchema,
    /** Who the key names on `operator` rows; null elsewhere, on the {@link ASSISTANT_SPEND_KEY} row, and for a principal nobody can name. */
    operator: operatorFactsSchema.nullable(),
    /**
     * The work item the key names on `work_item` rows; null on the
     * {@link NO_WORK_ITEM_KEY} row, and absent on the
     * {@link ASSISTANT_SPEND_KEY} row and on every other grouping.
     */
    workItem: spendWorkItemSchema.nullable().optional(),
    /**
     * The row's costliest runs in the period, at most
     * {@link SPEND_TOP_RUNS_MAX}; most calls first where nothing priced them.
     * Empty on the {@link OTHER_SPEND_KEY} row and always empty on the
     * {@link ASSISTANT_SPEND_KEY} row. `runs` says how many there are.
     */
    topRuns: z.array(spendTopRunSchema).max(SPEND_TOP_RUNS_MAX),
    /**
     * The row's prompt sources over its runs (#5295). Present on a row that
     * holds whole runs: operator, agent, task, cost center, work item, and
     * the {@link ASSISTANT_SPEND_KEY} row of those groupings. Absent on a model,
     * tool, or MCP server row, which holds part of a run, and on the
     * {@link OTHER_SPEND_KEY} row.
     */
    tokenSources: spendTokenSourcesSchema.optional(),
  })
  .strict();

export const spendGet = registerCapability({
  name: "get_spend",
  domain: "spend",
  description:
    "Read this workspace's spend over a day range, rolled up by operator, agent, model, tool, task, cost center or MCP server, with every figure in micros and the basis that says who observed it, the period total with proven and accepted spend kept apart, the spend by day, each row's costliest runs, and on a row of whole runs the tokens those runs spent on tool definitions, context frames, steering and tool results.",
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
      groupBy: spendGroupBySchema,
    })
    .strict(),
  output: z
    .object({
      period: z.object({ from: z.string(), to: z.string() }).strict(),
      groupBy: spendGroupBySchema,
      /** The period over every group: the strip at the top of the page. */
      total: spendFigureSchema,
      /** One entry per day of the period, oldest first, days with no run included. */
      days: z.array(spendDaySchema),
      /**
       * The part of the total the harness reported rather than the gateway
       * metered: every model whose frames were all `client_attested`. A
       * model whose frames mix both counts as metered. Null when no
       * harness-reported model carries a cost.
       */
      reported: moneySchema.nullable(),
      /**
       * The part of the total the gateway metered: every model whose frames
       * were all `gateway_observed`. A model with `mixed` or `estimated`
       * frames counts as not observed, so this is a floor. Null when no
       * gateway-observed model carries a cost. Absent from an answer built
       * before it was read.
       */
      observed: moneySchema.nullable().optional(),
      /**
       * What the period's model calls carried besides the conversation, in
       * tokens, from the run rows: the standing context by source, and the
       * tool results. Each tool result counts once, when it was recorded,
       * and not again for each later call that re-sent it. A part no run
       * recorded is null. Absent from an answer built before it was read.
       */
      composition: standingTokensSchema
        .extend({
          toolResultTokens: z.number().int().nonnegative().nullable(),
        })
        .strict()
        .optional(),
      /**
       * Priced runs in the period that were still open when their rollup was
       * last built (#3980). Their cost is in every figure here as a running
       * estimate over the calls recorded so far, and grows until they seal.
       */
      estimatedRuns: z.number().int().nonnegative().optional(),
      /** Runs in the period that recorded no usage, by harness. */
      unmeteredRuns: unmeteredRunsSchema.optional(),
      /** Largest spend first; groups with no cost after those with one. */
      rows: z.array(spendRowSchema),
    })
    .strict(),
});

export type SpendGetInput = z.output<typeof spendGet.input>;
export type SpendGetOutput = z.output<typeof spendGet.output>;
export type SpendGroupBy = z.output<typeof spendGroupBySchema>;
export type SpendRow = z.output<typeof spendRowSchema>;
export type SpendTopRun = z.output<typeof spendTopRunSchema>;
export type SpendTokenSources = z.output<typeof spendTokenSourcesSchema>;
