import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { semanticEdgeInfer } from "@oxagen/oxagen/contracts/semantic.edge.infer";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...semanticEdgeInfer.input.shape,
  sourceIds: semanticEdgeInfer.input.shape.sourceIds.describe(
    "Restrict inference to nodes from these connector source IDs (optional — omit to consider all sources).",
  ),
  maxEdgesPerNode: semanticEdgeInfer.input.shape.maxEdgesPerNode.describe(
    "Maximum inferred edges to emit per node (limits combinatorial explosion, default 10).",
  ),
  dryRun: semanticEdgeInfer.input.shape.dryRun.describe(
    "Preview inferred edges without persisting them to the graph.",
  ),
  semanticEdgePrompt: semanticEdgeInfer.input.shape.semanticEdgePrompt.describe(
    "Custom prompt instructing the LLM on how to identify and type relationships between nodes.",
  ),
  confidenceThreshold: semanticEdgeInfer.input.shape.confidenceThreshold.describe(
    "Edges at or above this score are auto-accepted; edges below are staged for review (0.0–1.0, default 0.8).",
  ),
};

export const metadata: ToolMetadata = {
  name: semanticEdgeInfer.name,
  description: semanticEdgeInfer.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function semanticEdgeInferTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(semanticEdgeInfer.name, args, ctx, { surface: "mcp" });
  return semanticEdgeInfer.output.parse(output);
}
