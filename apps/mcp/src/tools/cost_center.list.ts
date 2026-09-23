import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { costCenterList } from "@oxagen/oxagen/contracts/cost_center.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...costCenterList.input.shape };

export const metadata: ToolMetadata = {
  name: costCenterList.name,
  description: costCenterList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function costCenterListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(costCenterList.name, args, ctx, {
    surface: "mcp",
  });
  return costCenterList.output.parse(output);
}
