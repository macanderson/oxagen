import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginDenylistAdd } from "@oxagen/oxagen/contracts/plugin.denylist.add";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...pluginDenylistAdd.input.shape,
};

export const metadata: ToolMetadata = {
  name: pluginDenylistAdd.name,
  description: pluginDenylistAdd.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function pluginDenylistAddTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginDenylistAdd.name, args, ctx, { surface: "mcp" });
  return pluginDenylistAdd.output.parse(output);
}
