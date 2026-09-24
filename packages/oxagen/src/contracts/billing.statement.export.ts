/**
 * `export_billing_statement`: the organization's billing statement for one
 * period as a file (ADR-165). The period rules are `get_billing_statement`'s.
 *
 *   - `csv`: a header block with the statement's summary, then one line per
 *     `billing.gau_ledger` row billed in the period (billed and occurred
 *     instants, source, capability or tool, workspace, agent, operator, run,
 *     session, tool call, request and units). A year can hold millions of
 *     rows, so the rows come in pages of at most `limit`. The first page
 *     carries the header block and the column line. A page with more to
 *     follow returns `nextCursor`, and the next call passes it back with the
 *     same period: that page carries rows only, so the pages concatenate in
 *     order into one file.
 *   - `html`: one self-contained, printable document (inline CSS, no external
 *     assets) with every section of the statement and its reconciliation
 *     notes. It carries the summaries, not the line items.
 *
 * A console read is never a governed action (ADR-052 exclusion 2):
 * `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { statementPeriodInputShape } from "./billing.statement.get";

/** Ledger rows per CSV page: the default, and the most one call answers. */
export const STATEMENT_CSV_PAGE_DEFAULT = 10_000;
export const STATEMENT_CSV_PAGE_MAX = 50_000;

/** The CSV line-item columns, in order. */
export const STATEMENT_LINE_ITEM_COLUMNS = [
  "ledger_entry_id",
  "billed_at",
  "occurred_at",
  "source",
  "capability",
  "tool_name",
  "mcp_server",
  "surface",
  "harness",
  "workspace_id",
  "workspace",
  "agent_id",
  "agent",
  "operator_user_id",
  "operator",
  "principal_id",
  "principal_kind",
  "run_id",
  "session_id",
  "tool_call_id",
  "request_id",
  "units",
] as const;

export const billingStatementExport = registerCapability({
  name: "export_billing_statement",
  domain: "billing",
  description:
    "Export the organization's billing statement for a week, month, quarter, year or custom period longer than 48 hours, as CSV with every billed governed action (paged by cursor) or as a printable HTML document.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "cli", "unit", "docs", "app"],
  scoped: true,
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
      ...statementPeriodInputShape,
      format: z.enum(["csv", "html"]).default("csv"),
      /** csv: ledger rows in this page. */
      limit: z
        .number()
        .int()
        .min(1)
        .max(STATEMENT_CSV_PAGE_MAX)
        .default(STATEMENT_CSV_PAGE_DEFAULT),
      /** csv: the nextCursor of the page before; only a cursor this capability returned for the same period is accepted. */
      cursor: z.string().max(512).optional(),
    })
    .strict(),
  output: z
    .object({
      reference: z.string(),
      format: z.enum(["csv", "html"]),
      filename: z.string(),
      mediaType: z.enum(["text/csv", "text/html"]),
      content: z.string(),
      /** csv: ledger rows in this page. html: 0. */
      lines: z.number().int().nonnegative(),
      /** csv: pass back for the next page; null on the last. html: null. */
      nextCursor: z.string().nullable(),
    })
    .strict(),
});

export type BillingStatementExportInput = z.output<
  typeof billingStatementExport.input
>;
export type BillingStatementExportOutput = z.output<
  typeof billingStatementExport.output
>;
