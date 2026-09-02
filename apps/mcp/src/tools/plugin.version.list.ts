import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginVersionList } from "@oxagen/oxagen/contracts/plugin.version.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...pluginVersionList.input.shape,
  pluginId: pluginVersionList.input.shape.pluginId.describe(
    "Connector plugin identifier (e.g. 'github', 'google-drive')",
  ),
  limit: pluginVersionList.input.shape.limit.describe(
    "Maximum number of versions to return, newest first (1–50, default 20)",
  ),
  includeChangelog: pluginVersionList.input.shape.includeChangelog.describe(
    "When true, include full markdown changelog per version. False returns summary only.",
  ),
};

export const metadata: ToolMetadata = {
  name: pluginVersionList.name,
  description: pluginVersionList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function pluginVersionListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginVersionList.name, args, ctx, {
    surface: "mcp",
  });
  return pluginVersionList.output.parse(output);
}
