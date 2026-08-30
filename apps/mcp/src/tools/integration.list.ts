import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { integrationList } from "@oxagen/oxagen/contracts/integration.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...integrationList.input.shape,
  status: integrationList.input.shape.status.describe(
    "Filter by status: active, paused, failed, or pending_setup",
  ),
  pluginId: integrationList.input.shape.pluginId.describe(
    "Filter by plugin type (e.g., 'github', 'google-drive')",
  ),
  limit: integrationList.input.shape.limit.describe(
    "Maximum number of integrations to return (1–250, default 50)",
  ),
  offset: integrationList.input.shape.offset.describe(
    "Zero-based pagination offset",
  ),
};

export const metadata: ToolMetadata = {
  name: integrationList.name,
  description: integrationList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function integrationListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(integrationList.name, args, ctx, {
    surface: "mcp",
  });
  return integrationList.output.parse(output);
}
