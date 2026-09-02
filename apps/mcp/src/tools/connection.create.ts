import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { connectionCreate } from "@oxagen/oxagen/contracts/connection.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...connectionCreate.input.shape };

export const metadata: ToolMetadata = {
  name: connectionCreate.name,
  description: connectionCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function connectionCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  return invoke(connectionCreate.name, args, ctx, { surface: "mcp" });
}
