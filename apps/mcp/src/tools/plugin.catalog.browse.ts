import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginCatalogBrowse } from "@oxagen/oxagen/contracts/plugin.catalog.browse";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...pluginCatalogBrowse.input.shape,
};

export const metadata: ToolMetadata = {
  name: pluginCatalogBrowse.name,
  description: pluginCatalogBrowse.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function pluginCatalogBrowseTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginCatalogBrowse.name, args, ctx, {
    surface: "mcp",
  });
  return pluginCatalogBrowse.output.parse(output);
}
