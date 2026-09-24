import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { billingStatementGet } from "@oxagen/oxagen/contracts/billing.statement.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...billingStatementGet.input.shape,
  period: billingStatementGet.input.shape.period.describe(
    "week, month, quarter or year (UTC, with anchor), or custom (with from and to)",
  ),
  anchor: billingStatementGet.input.shape.anchor.describe(
    "For week, month, quarter or year: a UTC date inside the period, YYYY-MM-DD",
  ),
  from: billingStatementGet.input.shape.from.describe(
    "For custom: the first instant, RFC 3339. The range must be longer than 48 hours and at most 366 days",
  ),
  to: billingStatementGet.input.shape.to.describe(
    "For custom: the first instant after the period, RFC 3339",
  ),
  top: billingStatementGet.input.shape.top.describe(
    "Rows per breakdown (workspace, agent, operator, capability or tool) before the rest fold into other; 1 to 100",
  ),
};

export const metadata: ToolMetadata = {
  name: billingStatementGet.name,
  description: billingStatementGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function billingStatementGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(billingStatementGet.name, args, ctx, {
    surface: "mcp",
  });
  return billingStatementGet.output.parse(output);
}
