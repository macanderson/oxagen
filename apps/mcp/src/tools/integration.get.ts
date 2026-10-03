import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { integrationGet } from "@oxagen/oxagen/contracts/integration.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  ...integrationGet.input.shape,
  integrationId: integrationGet.input.shape.integrationId.describe(
    "Plugin instance ID to retrieve",
  ),
};

export const metadata: ToolMetadata = {
  name: integrationGet.name,
  description: integrationGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function integrationGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(integrationGet.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(integrationGet.output.parse(output));
}
