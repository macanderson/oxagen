import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { spendStatementExport } from "@oxagen/oxagen/contracts/spend.statement.export";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...spendStatementExport.input.shape,
  month: spendStatementExport.input.shape.month.describe(
    "The UTC month to export, YYYY-MM",
  ),
  format: spendStatementExport.input.shape.format.describe(
    "The statement format; csv is the one format today",
  ),
};

export const metadata: ToolMetadata = {
  name: spendStatementExport.name,
  description: spendStatementExport.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function spendStatementExportTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(spendStatementExport.name, args, ctx, {
    surface: "mcp",
  });
  return spendStatementExport.output.parse(output);
}
