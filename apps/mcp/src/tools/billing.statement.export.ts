import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { billingStatementExport } from "@oxagen/oxagen/contracts/billing.statement.export";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...billingStatementExport.input.shape,
  period: billingStatementExport.input.shape.period.describe(
    "week, month, quarter or year (UTC, with anchor), or custom (with from and to)",
  ),
  anchor: billingStatementExport.input.shape.anchor.describe(
    "For week, month, quarter or year: a UTC date inside the period, YYYY-MM-DD",
  ),
  from: billingStatementExport.input.shape.from.describe(
    "For custom: the first instant, RFC 3339. The range must be longer than 48 hours and at most 366 days",
  ),
  to: billingStatementExport.input.shape.to.describe(
    "For custom: the first instant after the period, RFC 3339",
  ),
  format: billingStatementExport.input.shape.format.describe(
    "csv: every billed governed action, paged. html: one printable document of the whole statement",
  ),
  limit: billingStatementExport.input.shape.limit.describe(
    "csv: ledger rows in this page, 1 to 50000",
  ),
  cursor: billingStatementExport.input.shape.cursor.describe(
    "csv: the nextCursor of the page before, with the same period; omit for the first page",
  ),
};

export const metadata: ToolMetadata = {
  name: billingStatementExport.name,
  description: billingStatementExport.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function billingStatementExportTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(billingStatementExport.name, args, ctx, {
    surface: "mcp",
  });
  return billingStatementExport.output.parse(output);
}
