import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { connectionMappingsSet } from "@oxagen/oxagen/contracts/connection.mappings.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...connectionMappingsSet.input.shape };

export const metadata: ToolMetadata = {
  name: connectionMappingsSet.name,
  description: connectionMappingsSet.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function connectionMappingsSetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  return invoke(connectionMappingsSet.name, args, ctx, { surface: "mcp" });
}
