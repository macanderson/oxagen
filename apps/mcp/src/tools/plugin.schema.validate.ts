import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginSchemaValidate } from "@oxagen/oxagen/contracts/plugin.schema.validate";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...pluginSchemaValidate.input.shape,
  pluginId: pluginSchemaValidate.input.shape.pluginId.describe(
    "Connector plugin identifier (e.g. 'github', 'google-drive')",
  ),
  authSchemeId: pluginSchemaValidate.input.shape.authSchemeId.describe(
    "Auth scheme being used (e.g. 'oauth2', 'pat'). Required when the plugin has multiple auth schemes.",
  ),
  config: pluginSchemaValidate.input.shape.config.describe(
    "Config values keyed by field key to validate against the plugin schema",
  ),
};

export const metadata: ToolMetadata = {
  name: pluginSchemaValidate.name,
  description: pluginSchemaValidate.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function pluginSchemaValidateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginSchemaValidate.name, args, ctx, {
    surface: "mcp",
  });
  return pluginSchemaValidate.output.parse(output);
}
