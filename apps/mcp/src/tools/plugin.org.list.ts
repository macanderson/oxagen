import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginOrgList } from "@oxagen/oxagen/contracts/plugin.org.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...pluginOrgList.input.shape,
};

export const metadata: ToolMetadata = {
  name: pluginOrgList.name,
  description: pluginOrgList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function pluginOrgListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginOrgList.name, args, ctx, {
    surface: "mcp",
  });
  return pluginOrgList.output.parse(output);
}
