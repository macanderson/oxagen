import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginCatalogSync } from "@oxagen/oxagen/contracts/plugin.catalog.sync";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
export const schema = {
  ...pluginCatalogSync.input.shape,
};
export const metadata: ToolMetadata = {
  name: pluginCatalogSync.name,
  description: pluginCatalogSync.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};
export default async function pluginCatalogSyncTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginCatalogSync.name, args, ctx, {
    surface: "mcp",
  });
  return pluginCatalogSync.output.parse(output);
}
