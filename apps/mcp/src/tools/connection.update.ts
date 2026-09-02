import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { connectionUpdate } from "@oxagen/oxagen/contracts/connection.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...connectionUpdate.input.shape,
};

export const metadata: ToolMetadata = {
  name: connectionUpdate.name,
  description: connectionUpdate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function connectionUpdateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(connectionUpdate.name, args, ctx, {
    surface: "mcp",
  });
  return connectionUpdate.output.parse(output);
}
