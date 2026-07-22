import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { lineageQuery } from "@oxagen/oxagen/contracts/lineage.query";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...lineageQuery.input.shape,
  dispatchId: lineageQuery.input.shape.dispatchId.describe(
    "Public ID of the root fan-out (agent.subagent_fanouts.publicId) — the dispatchId returned by dispatch_subagent.",
  ),
  maxDepth: lineageQuery.input.shape.maxDepth.describe(
    "Maximum nesting depth to walk — a run dispatching its own subagents counts as one level. 1-10, default 5.",
  ),
  maxNodes: lineageQuery.input.shape.maxNodes.describe(
    "Maximum number of run nodes to return across the whole tree. 1-500, default 200; see `truncated` in the output.",
  ),
};

export const metadata: ToolMetadata = {
  name: lineageQuery.name,
  description: lineageQuery.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function lineageQueryTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(lineageQuery.name, args, ctx, {
    surface: "mcp",
  });
  return lineageQuery.output.parse(output);
}
