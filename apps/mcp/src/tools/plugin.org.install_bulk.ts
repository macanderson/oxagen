import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginOrgInstallBulk } from "@oxagen/oxagen/contracts/plugin.org.install_bulk";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...pluginOrgInstallBulk.input.shape,
};

export const metadata: ToolMetadata = {
  name: pluginOrgInstallBulk.name,
  description: pluginOrgInstallBulk.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function pluginOrgInstallBulkTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginOrgInstallBulk.name, args, ctx, {
    surface: "mcp",
  });
  return pluginOrgInstallBulk.output.parse(output);
}
