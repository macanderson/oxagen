import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginSchemaGet } from "@oxagen/oxagen/contracts/plugin.schema.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...pluginSchemaGet.input.shape,
  pluginId: pluginSchemaGet.input.shape.pluginId.describe(
    "Connector plugin identifier (e.g. 'github', 'google-drive')",
  ),
};

export const metadata: ToolMetadata = {
  name: pluginSchemaGet.name,
  description: pluginSchemaGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function pluginSchemaGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginSchemaGet.name, args, ctx, {
    surface: "mcp",
  });
  return pluginSchemaGet.output.parse(output);
}
