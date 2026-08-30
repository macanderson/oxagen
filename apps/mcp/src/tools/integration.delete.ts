import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { integrationDelete } from "@oxagen/oxagen/contracts/integration.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...integrationDelete.input.shape,
  integrationId: integrationDelete.input.shape.integrationId.describe(
    "Plugin instance ID to remove",
  ),
  purgeData: integrationDelete.input.shape.purgeData.describe(
    "When true, also deletes all entities and edges from this plugin in Neo4j (default false)",
  ),
};

export const metadata: ToolMetadata = {
  name: integrationDelete.name,
  description: integrationDelete.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function integrationDeleteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(integrationDelete.name, args, ctx, {
    surface: "mcp",
  });
  return integrationDelete.output.parse(output);
}
