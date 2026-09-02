import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { connectionMappingsGet } from "@oxagen/oxagen/contracts/connection.mappings.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...connectionMappingsGet.input.shape };

export const metadata: ToolMetadata = {
  name: connectionMappingsGet.name,
  description: connectionMappingsGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function connectionMappingsGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  return invoke(connectionMappingsGet.name, args, ctx, { surface: "mcp" });
}
