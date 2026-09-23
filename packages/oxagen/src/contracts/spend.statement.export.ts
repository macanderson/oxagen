/**
 * `export_statement`: the monthly statement for this workspace as CSV
 * (Mission Control spec §12.9 "Monthly statement", App. E; ADR-060). One line
 * per group at every level (operator, agent, model, tool, task, cost center)
 * with the month's calls, runs, cost in micros and, on that one line, the cost in
 * cents rounded half to even (spec §12.3: rounding to cents happens once, at
 * the statement line). Every line names its basis.
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

export const spendStatementExport = registerCapability({
  name: "export_statement",
  domain: "spend",
  description:
    "Export this workspace's monthly spend statement as CSV: one line per operator, agent, model, tool, task and cost center (spend with no cost center on its own line) with runs, calls, cost in micros and in cents rounded half to even once, the basis, and proven and accepted spend kept apart.",
  mode: "sync",
  surfaces: ["api", "mcp"],
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
      /** The CSV text: a header line then one line per group. */
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
