import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { costCenterDelete } from "@oxagen/oxagen/contracts/cost_center.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...costCenterDelete.input.shape,
  label: costCenterDelete.input.shape.label.describe(
    "The cost-center label to delete from the organization's list",
  ),
};

export const metadata: ToolMetadata = {
  name: costCenterDelete.name,
  description: costCenterDelete.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    // Deleting a label that is already deleted answers not_found.
    idempotentHint: false,
  },
};

export default async function costCenterDeleteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(costCenterDelete.name, args, ctx, {
    surface: "mcp",
  });
  return costCenterDelete.output.parse(output);
}
