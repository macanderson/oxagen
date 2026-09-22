import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { costCenterCreate } from "@oxagen/oxagen/contracts/cost_center.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...costCenterCreate.input.shape,
  label: costCenterCreate.input.shape.label.describe(
    "The cost-center label: 1 to 64 letters, digits, '.', '_' or '-', starting with a letter or digit",
  ),
  description: costCenterCreate.input.shape.description.describe(
    "What the label charges back to, up to 280 characters",
  ),
};

export const metadata: ToolMetadata = {
  name: costCenterCreate.name,
  description: costCenterCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    // Adding a live label a second time is a conflict, not a no-op.
    idempotentHint: false,
  },
};

export default async function costCenterCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(costCenterCreate.name, args, ctx, {
    surface: "mcp",
  });
  return costCenterCreate.output.parse(output);
}
