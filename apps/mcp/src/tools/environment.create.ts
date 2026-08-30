import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { environmentCreate } from "@oxagen/oxagen/contracts/environment.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...environmentCreate.input.shape,
};

export const metadata: ToolMetadata = {
  name: environmentCreate.name,
  description: environmentCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function environmentCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(environmentCreate.name, args, ctx, {
    surface: "mcp",
  });
  return environmentCreate.output.parse(output);
}
