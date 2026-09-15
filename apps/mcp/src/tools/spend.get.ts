import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { spendGet } from "@oxagen/oxagen/contracts/spend.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...spendGet.input.shape,
  period: spendGet.input.shape.period.describe(
    "Inclusive UTC day range, { from: YYYY-MM-DD, to: YYYY-MM-DD }",
  ),
  groupBy: spendGet.input.shape.groupBy.describe(
    "The level to roll up by: operator, agent, model, tool or task",
  ),
};

export const metadata: ToolMetadata = {
  name: spendGet.name,
  description: spendGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function spendGetTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(spendGet.name, args, ctx, { surface: "mcp" });
  return spendGet.output.parse(output);
}
