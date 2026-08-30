import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginSetEnabled } from "@oxagen/oxagen/contracts/plugin.set_enabled";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...pluginSetEnabled.input.shape,
};

export const metadata: ToolMetadata = {
  name: pluginSetEnabled.name,
  description: pluginSetEnabled.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function pluginSetEnabledTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginSetEnabled.name, args, ctx, {
    surface: "mcp",
  });
  return pluginSetEnabled.output.parse(output);
}
