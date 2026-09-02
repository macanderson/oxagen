import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { apiKeyRevoke } from "@oxagen/oxagen/contracts/api.key.revoke";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...apiKeyRevoke.input.shape,
  keyPublicId: apiKeyRevoke.input.shape.keyPublicId.describe(
    "The aky_* public ID of the API key to revoke",
  ),
};

export const metadata: ToolMetadata = {
  name: apiKeyRevoke.name,
  description: apiKeyRevoke.description,
  annotations: {
    readOnlyHint: false,
    // Destructive: immediately invalidates the API key for all callers.
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function apiKeyRevokeTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(apiKeyRevoke.name, args, ctx, { surface: "mcp" });
  return apiKeyRevoke.output.parse(output);
}
