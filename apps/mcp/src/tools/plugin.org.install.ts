import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginOrgInstall } from "@oxagen/oxagen/contracts/plugin.org.install";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...pluginOrgInstall.input.shape,
};

export const metadata: ToolMetadata = {
  name: pluginOrgInstall.name,
  description: pluginOrgInstall.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function pluginOrgInstallTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginOrgInstall.name, args, ctx, {
    surface: "mcp",
  });
  return pluginOrgInstall.output.parse(output);
}
