import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { environmentUpdate } from "@oxagen/oxagen/contracts/environment.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...environmentUpdate.input.shape,
};

export const metadata: ToolMetadata = {
  name: environmentUpdate.name,
  description: environmentUpdate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function environmentUpdateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(environmentUpdate.name, args, ctx, {
    surface: "mcp",
  });
  return environmentUpdate.output.parse(output);
}
