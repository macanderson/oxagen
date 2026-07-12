import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { capabilityRegistryGet } from "@oxagen/oxagen/contracts/capability.registry.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...capabilityRegistryGet.input.shape,
};

export const metadata: ToolMetadata = {
  name: capabilityRegistryGet.name,
  description: capabilityRegistryGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function capabilityRegistryGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(capabilityRegistryGet.name, args, ctx, {
    surface: "mcp",
  });
  return capabilityRegistryGet.output.parse(output);
}
