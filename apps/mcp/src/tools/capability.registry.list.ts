import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { capabilityRegistryList } from "@oxagen/oxagen/contracts/capability.registry.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...capabilityRegistryList.input.shape,
};

export const metadata: ToolMetadata = {
  name: capabilityRegistryList.name,
  description: capabilityRegistryList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function capabilityRegistryListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(capabilityRegistryList.name, args, ctx, {
    surface: "mcp",
  });
  return capabilityRegistryList.output.parse(output);
}
