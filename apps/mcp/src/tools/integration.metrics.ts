import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { integrationMetrics } from "@oxagen/oxagen/contracts/integration.metrics";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...integrationMetrics.input.shape,
  integrationId: integrationMetrics.input.shape.integrationId.describe(
    "Plugin instance ID to fetch metrics for",
  ),
};

export const metadata: ToolMetadata = {
  name: integrationMetrics.name,
  description: integrationMetrics.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function integrationMetricsTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(integrationMetrics.name, args, ctx, {
    surface: "mcp",
  });
  return integrationMetrics.output.parse(output);
}
