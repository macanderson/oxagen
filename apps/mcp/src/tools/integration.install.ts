import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { integrationInstall } from "@oxagen/oxagen/contracts/integration.install";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...integrationInstall.input.shape,
  pluginId: integrationInstall.input.shape.pluginId.describe(
    "Plugin identifier from catalog (e.g., 'github', 'google-drive')",
  ),
  version: integrationInstall.input.shape.version.describe(
    "Plugin version to install (omit to use latest)",
  ),
  schemaUrl: integrationInstall.input.shape.schemaUrl.describe(
    "For custom plugins: HTTPS URL to fetch schema.yaml from",
  ),
  config: integrationInstall.input.shape.config.describe(
    "Plugin configuration matching the plugin schema",
  ),
  displayName: integrationInstall.input.shape.displayName.describe(
    "Human-readable display name for this plugin instance",
  ),
};

export const metadata: ToolMetadata = {
  name: integrationInstall.name,
  description: integrationInstall.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function integrationInstallTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(integrationInstall.name, args, ctx, {
    surface: "mcp",
  });
  return integrationInstall.output.parse(output);
}
