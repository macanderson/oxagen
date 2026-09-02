import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { environmentDelete } from "@oxagen/oxagen/contracts/environment.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...environmentDelete.input.shape,
};

export const metadata: ToolMetadata = {
  name: environmentDelete.name,
  description: environmentDelete.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function environmentDeleteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(environmentDelete.name, args, ctx, {
    surface: "mcp",
  });
  return environmentDelete.output.parse(output);
}
