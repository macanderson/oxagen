import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginOrgSetEnabled } from "@oxagen/oxagen/contracts/plugin.org.set_enabled";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...pluginOrgSetEnabled.input.shape,
};

export const metadata: ToolMetadata = {
  name: pluginOrgSetEnabled.name,
  description: pluginOrgSetEnabled.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function pluginOrgSetEnabledTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginOrgSetEnabled.name, args, ctx, { surface: "mcp" });
  return pluginOrgSetEnabled.output.parse(output);
}
