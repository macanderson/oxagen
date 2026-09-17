import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { spendWasteList } from "@oxagen/oxagen/contracts/spend.waste";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...spendWasteList.input.shape,
  period: spendWasteList.input.shape.period.describe(
    "Inclusive UTC day range, { from: YYYY-MM-DD, to: YYYY-MM-DD }",
  ),
};

export const metadata: ToolMetadata = {
  name: spendWasteList.name,
  description: spendWasteList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function spendWasteListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(spendWasteList.name, args, ctx, {
    surface: "mcp",
  });
  return spendWasteList.output.parse(output);
}
