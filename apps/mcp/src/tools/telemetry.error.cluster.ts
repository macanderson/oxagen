import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { telemetryErrorCluster } from "@oxagen/oxagen/contracts/telemetry.error.cluster";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...telemetryErrorCluster.input.shape,
  sinceHours: telemetryErrorCluster.input.shape.sinceHours.describe(
    "Lookback window in hours (default: 24, max: 720 / 30 days)",
  ),
  limit: telemetryErrorCluster.input.shape.limit.describe(
    "Max distinct clusters to return, ranked by occurrence count (default: 20)",
  ),
};

export const metadata: ToolMetadata = {
  name: telemetryErrorCluster.name,
  description: telemetryErrorCluster.description,
  annotations: {
    // Read-only aggregation over already-captured errors; mutates nothing and
    // is stable for a given window (same inputs → same clusters).
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function telemetryErrorClusterTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(telemetryErrorCluster.name, args, ctx, {
    surface: "mcp",
  });
  return telemetryErrorCluster.output.parse(output);
}
