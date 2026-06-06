import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginDenylistRemove } from "@oxagen/oxagen/contracts/plugin.denylist.remove";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...pluginDenylistRemove.input.shape,
};

export const metadata: ToolMetadata = {
  name: pluginDenylistRemove.name,
  description: pluginDenylistRemove.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function pluginDenylistRemoveTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginDenylistRemove.name, args, ctx, { surface: "mcp" });
  return pluginDenylistRemove.output.parse(output);
}
