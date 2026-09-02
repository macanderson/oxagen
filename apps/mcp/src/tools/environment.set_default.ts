import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { environmentSetDefault } from "@oxagen/oxagen/contracts/environment.set_default";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...environmentSetDefault.input.shape,
};

export const metadata: ToolMetadata = {
  name: environmentSetDefault.name,
  description: environmentSetDefault.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function environmentSetDefaultTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(environmentSetDefault.name, args, ctx, {
    surface: "mcp",
  });
  return environmentSetDefault.output.parse(output);
}
