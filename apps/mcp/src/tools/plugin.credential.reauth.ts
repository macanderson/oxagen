import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginCredentialReauth } from "@oxagen/oxagen/contracts/plugin.credential.reauth";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...pluginCredentialReauth.input.shape,
};

export const metadata: ToolMetadata = {
  name: pluginCredentialReauth.name,
  description: pluginCredentialReauth.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function pluginCredentialReauthTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginCredentialReauth.name, args, ctx, {
    surface: "mcp",
  });
  return pluginCredentialReauth.output.parse(output);
}
