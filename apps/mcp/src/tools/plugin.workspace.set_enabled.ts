import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginWorkspaceSetEnabled } from "@oxagen/oxagen/contracts/plugin.workspace.set_enabled";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...pluginWorkspaceSetEnabled.input.shape,
};

export const metadata: ToolMetadata = {
  name: pluginWorkspaceSetEnabled.name,
  description: pluginWorkspaceSetEnabled.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function pluginWorkspaceSetEnabledTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginWorkspaceSetEnabled.name, args, ctx, { surface: "mcp" });
  return pluginWorkspaceSetEnabled.output.parse(output);
}
