import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repoMetrics } from "@oxagen/oxagen/contracts/repo.metrics";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  ...repoMetrics.input.shape,
  repoId: repoMetrics.input.shape.repoId.describe("Repository connection ID"),
};

export const metadata: ToolMetadata = {
  name: repoMetrics.name,
  description: repoMetrics.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function repoMetricsTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(repoMetrics.name, args, ctx, { surface: "mcp" });
  return toolResult(repoMetrics.output.parse(output));
}
