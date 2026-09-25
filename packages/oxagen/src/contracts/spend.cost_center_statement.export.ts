/**
 * `export_cost_center_statement`: the organization's monthly chargeback
 * statement, one line per cost center with the run ids that make it up
 * (ADR-142). Organization-wide (`scoped: false`): a cost center spans
 * workspaces, so the statement reads every workspace's `cost.run_totals`
 * rows for the month.
 *
 * Every run lands on exactly one line, the unassigned line included, at its
 * full run cost, so the lines' micros sum to the total's micros. Cents are
 * rounded once per line, half to even (spec §12.3), and the total's cents
 * are rounded once from the total's micros, so the line cents can differ
 * from the total cents by the rounding; micros are the figure that
 * reconciles. A run no frame priced is counted and listed on its line and
 * adds nothing to its cost; `unpriced_runs` says how many.
 *
 * The CSV `run_ids` field lists every run on its line. The `lines` data lists
 * the oldest {@link COST_CENTER_STATEMENT_LINE_RUN_IDS_LIMIT} of them and
 * counts the rest in `runIdsOmitted`, so a month of many thousands of runs
 * does not carry each id twice in one response.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { costSchema, monthSchema } from "./spend.shared";

export const COST_CENTER_STATEMENT_COLUMNS = [
  "line",
  "cost_center",
  "runs",
  "unpriced_runs",
  "cost_micros",
  "cost_cents",
  "currency",
  "basis",
  "run_ids",
] as const;

/** How many run ids one line of the `lines` data lists. The CSV lists them all. */
export const COST_CENTER_STATEMENT_LINE_RUN_IDS_LIMIT = 100;

export const costCenterStatementLineSchema = z
  .object({
    /** The label, or `~none` for the spend no cost center claims. */
    costCenter: z.string(),
    runs: z.number().int().nonnegative(),
    unpricedRuns: z.number().int().nonnegative(),
    /** Null when no run on the line was priced. */
    cost: costSchema.nullable(),
    /**
     * The oldest runs on the line, at most
     * {@link COST_CENTER_STATEMENT_LINE_RUN_IDS_LIMIT}. The CSV `run_ids`
     * field lists every one: the record each figure traces to.
     */
    runIds: z.array(z.string()).max(COST_CENTER_STATEMENT_LINE_RUN_IDS_LIMIT),
    /** Runs on the line that `runIds` leaves out. The CSV lists their ids. */
    runIdsOmitted: z.number().int().nonnegative(),
  })
  .strict();
export type CostCenterStatementLine = z.output<
  typeof costCenterStatementLineSchema
>;

export const spendCostCenterStatementExport = registerCapability({
  name: "export_cost_center_statement",
  domain: "spend",
  description:
    "Export this organization's monthly chargeback statement as CSV: one line per cost center, and one for spend with no cost center, with runs, cost in micros and in cents, the basis, and the run ids that make up each line, plus the organization total they sum to.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: false,
  noBillingGate: true,
  mutates: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Billing: "allow" },
    workspace: {},
  },
  input: z
    .object({
      month: monthSchema,
      format: z.enum(["csv"]).default("csv"),
    })
    .strict(),
  output: z
    .object({
      month: monthSchema,
      filename: z.string(),
      mediaType: z.literal("text/csv"),
      /** The CSV text: a header, one `cost_center` line per center, then one `total` line. */
      content: z.string(),
      /** Largest cost first; the unassigned line last. */
      lines: z.array(costCenterStatementLineSchema),
      total: z
        .object({
          runs: z.number().int().nonnegative(),
          unpricedRuns: z.number().int().nonnegative(),
          cost: costSchema.nullable(),
        })
        .strict(),
    })
    .strict(),
});

export type SpendCostCenterStatementExportOutput = z.output<
  typeof spendCostCenterStatementExport.output
>;
