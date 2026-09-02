import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginOrgUninstall } from "@oxagen/oxagen/contracts/plugin.org.uninstall";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...pluginOrgUninstall.input.shape,
};

export const metadata: ToolMetadata = {
  name: pluginOrgUninstall.name,
  description: pluginOrgUninstall.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function pluginOrgUninstallTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginOrgUninstall.name, args, ctx, {
    surface: "mcp",
  });
  return pluginOrgUninstall.output.parse(output);
}
