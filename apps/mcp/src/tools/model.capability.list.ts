import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { modelCapabilityList } from "@oxagen/oxagen/contracts/model.capability.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...modelCapabilityList.input.shape,
};

export const metadata: ToolMetadata = {
  name: modelCapabilityList.name,
  description: modelCapabilityList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function modelCapabilityListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(modelCapabilityList.name, args, ctx, {
    surface: "mcp",
  });
  return modelCapabilityList.output.parse(output);
}
