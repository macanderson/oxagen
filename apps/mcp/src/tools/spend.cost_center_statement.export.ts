import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { spendCostCenterStatementExport } from "@oxagen/oxagen/contracts/spend.cost_center_statement.export";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...spendCostCenterStatementExport.input.shape,
  month: spendCostCenterStatementExport.input.shape.month.describe(
    "The UTC month to export, YYYY-MM",
  ),
  format: spendCostCenterStatementExport.input.shape.format.describe(
    "The statement format; csv is the one format today",
  ),
};

export const metadata: ToolMetadata = {
  name: spendCostCenterStatementExport.name,
  description: spendCostCenterStatementExport.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function spendCostCenterStatementExportTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(spendCostCenterStatementExport.name, args, ctx, {
    surface: "mcp",
  });
  return spendCostCenterStatementExport.output.parse(output);
}
