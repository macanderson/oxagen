/**
 * `export_statement`: the monthly statement for this workspace as CSV
 * (Mission Control spec §12.9 "Monthly statement", App. E; ADR-060). One line
 * per group at every level (operator, agent, model, tool, task, cost center)
 * with the month's calls, runs, cost in micros and, on that one line, the cost in
 * cents rounded half to even (spec §12.3: rounding to cents happens once, at
 * the statement line). Every line names its basis.
 *
 * With `rows: "runs"`, the file has one line per run instead (the Spend
 * page's Export CSV, mockup README "Spend, Export"; #2962): its agent, its
 * operator, the work item it served, and its cost, rounded to cents once on
 * that line. The in-app assistant's runs share one line that names no run,
 * so the lines' micros add up to the month's total (ADR-235).
 *
 * The statement is built and answered in the call. A signed PDF and the
 * export job listed on Audit › exports wait on the audit-exports lane and a
 * signing key (ADR-060 §6).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { monthSchema } from "./spend.shared";

export const STATEMENT_COLUMNS = [
  "level",
  "key",
  "provider",
  "runs",
  "calls",
  "cost_micros",
  "cost_cents",
  "currency",
  "basis",
  "proven_micros",
  "accepted_micros",
] as const;

/**
 * The columns of the file with one line per run. `line` is `run` for a run
 * and `assistant` for the in-app assistant's runs, which name no run.
 * `runs` is 1 on a run line and the assistant's run count on its line.
 */
export const RUN_STATEMENT_COLUMNS = [
  "line",
  "run_id",
  "started_at",
  "sealed_at",
  "agent",
  "operator_key",
  "operator",
  "work_item",
  "work_item_title",
  "runs",
  "cost_micros",
  "cost_cents",
  "currency",
  "basis",
] as const;

/** What one line of the file stands for: a group of spend, or one run. */
export const statementRowsSchema = z.enum(["groups", "runs"]);

export const spendStatementExport = registerCapability({
  name: "export_statement",
  domain: "spend",
  description:
    "Export this workspace's monthly spend statement as CSV: one line per operator, agent, model, tool, task and cost center (spend with no cost center on its own line) with runs, calls, cost in micros and in cents rounded half to even once, the basis, and proven and accepted spend kept apart. With rows set to runs, one line per run instead, with its agent, operator, work item, and cost.",
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
  input: z
    .object({
      month: monthSchema,
      format: z.enum(["csv"]).default("csv"),
      /** `groups`, the statement, by default; `runs` for one line per run. */
      rows: statementRowsSchema.default("groups"),
    })
    .strict(),
  output: z
    .object({
      month: monthSchema,
      filename: z.string(),
      mediaType: z.literal("text/csv"),
      /** The CSV text: a header line, then one line per group or per run. */
      content: z.string(),
      /** Lines after the header. */
      lines: z.number().int().nonnegative(),
    })
    .strict(),
});

export type SpendStatementExportInput = z.output<
  typeof spendStatementExport.input
>;
export type SpendStatementExportOutput = z.output<
  typeof spendStatementExport.output
>;
export type StatementRows = z.output<typeof statementRowsSchema>;
