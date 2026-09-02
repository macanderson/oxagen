import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginCatalogGet } from "@oxagen/oxagen/contracts/plugin.catalog.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...pluginCatalogGet.input.shape,
};

export const metadata: ToolMetadata = {
  name: pluginCatalogGet.name,
  description: pluginCatalogGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function pluginCatalogGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginCatalogGet.name, args, ctx, {
    surface: "mcp",
  });
  return pluginCatalogGet.output.parse(output);
}
