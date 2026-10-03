import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { connectionMappingsSuggest } from "@oxagen/oxagen/contracts/connection.mappings.suggest";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

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
  const output = await invoke(connectionMappingsSuggest.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(output);
}
