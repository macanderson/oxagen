import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { integrationSync } from "@oxagen/oxagen/contracts/integration.sync";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...integrationSync.input.shape,
  integrationId: integrationSync.input.shape.integrationId.describe(
    "Plugin instance ID to sync",
  ),
  mode: integrationSync.input.shape.mode.describe(
    "Sync mode: incremental (since last cursor) or full (re-index from scratch)",
  ),
};

export const metadata: ToolMetadata = {
  name: integrationSync.name,
  description: integrationSync.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function integrationSyncTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(integrationSync.name, args, ctx, {
    surface: "mcp",
  });
  return integrationSync.output.parse(output);
}
