import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { apiKeyCreate } from "@oxagen/oxagen/contracts/api.key.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  ...apiKeyCreate.input.shape,
  name: apiKeyCreate.input.shape.name.describe(
    "Human-readable label for the API key",
  ),
};

export const metadata: ToolMetadata = {
  name: apiKeyCreate.name,
  description: apiKeyCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function apiKeyCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(apiKeyCreate.name, args, ctx, { surface: "mcp" });
  return toolResult(apiKeyCreate.output.parse(output));
}
