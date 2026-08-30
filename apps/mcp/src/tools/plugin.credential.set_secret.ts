import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginCredentialSetSecret } from "@oxagen/oxagen/contracts/plugin.credential.set_secret";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...pluginCredentialSetSecret.input.shape,
};

export const metadata: ToolMetadata = {
  name: pluginCredentialSetSecret.name,
  description: pluginCredentialSetSecret.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function pluginCredentialSetSecretTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginCredentialSetSecret.name, args, ctx, {
    surface: "mcp",
  });
  return pluginCredentialSetSecret.output.parse(output);
}
