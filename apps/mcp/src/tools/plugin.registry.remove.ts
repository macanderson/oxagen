import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginRegistryRemove } from "@oxagen/oxagen/contracts/plugin.registry.remove";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...pluginRegistryRemove.input.shape,
};

export const metadata: ToolMetadata = {
  name: pluginRegistryRemove.name,
  description: pluginRegistryRemove.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function pluginRegistryRemoveTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginRegistryRemove.name, args, ctx, {
    surface: "mcp",
  });
  return pluginRegistryRemove.output.parse(output);
}
