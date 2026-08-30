import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { connectionMappingsSuggest } from "@oxagen/oxagen/contracts/connection.mappings.suggest";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...connectionMappingsSuggest.input.shape };

export const metadata: ToolMetadata = {
  name: connectionMappingsSuggest.name,
  description: connectionMappingsSuggest.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function connectionMappingsSuggestTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  return invoke(connectionMappingsSuggest.name, args, ctx, { surface: "mcp" });
}
