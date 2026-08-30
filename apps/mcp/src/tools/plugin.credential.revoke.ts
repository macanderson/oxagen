import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginCredentialRevoke } from "@oxagen/oxagen/contracts/plugin.credential.revoke";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...pluginCredentialRevoke.input.shape,
};

export const metadata: ToolMetadata = {
  name: pluginCredentialRevoke.name,
  description: pluginCredentialRevoke.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function pluginCredentialRevokeTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginCredentialRevoke.name, args, ctx, {
    surface: "mcp",
  });
  return pluginCredentialRevoke.output.parse(output);
}
