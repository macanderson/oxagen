import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginRegistryAdd } from "@oxagen/oxagen/contracts/plugin.registry.add";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  ...pluginRegistryAdd.input.shape,
};

export const metadata: ToolMetadata = {
  name: pluginRegistryAdd.name,
  description: pluginRegistryAdd.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function pluginRegistryAddTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginRegistryAdd.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(pluginRegistryAdd.output.parse(output));
}
