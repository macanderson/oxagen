import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginRegistryList } from "@oxagen/oxagen/contracts/plugin.registry.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {};

export const metadata: ToolMetadata = {
  name: pluginRegistryList.name,
  description: pluginRegistryList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function pluginRegistryListTool(
  _args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginRegistryList.name, {}, ctx, {
    surface: "mcp",
  });
  return pluginRegistryList.output.parse(output);
}
