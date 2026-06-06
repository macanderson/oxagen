import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginRegistrySync } from "@oxagen/oxagen/contracts/plugin.registry.sync";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...pluginRegistrySync.input.shape,
};

export const metadata: ToolMetadata = {
  name: pluginRegistrySync.name,
  description: pluginRegistrySync.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function pluginRegistrySyncTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginRegistrySync.name, args, ctx, { surface: "mcp" });
  return pluginRegistrySync.output.parse(output);
}
