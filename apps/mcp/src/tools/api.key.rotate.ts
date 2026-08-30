import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { apiKeyRotate } from "@oxagen/oxagen/contracts/api.key.rotate";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...apiKeyRotate.input.shape,
};

export const metadata: ToolMetadata = {
  name: apiKeyRotate.name,
  description: apiKeyRotate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function apiKeyRotateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(apiKeyRotate.name, args, ctx, { surface: "mcp" });
  return apiKeyRotate.output.parse(output);
}
