import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { graphNodeGet } from "@oxagen/oxagen/contracts/graph.node.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  nodeId: graphNodeGet.input.shape.nodeId.describe(
    "publicId of the KnowledgeNode to retrieve",
  ),
};

export const metadata: ToolMetadata = {
  name: graphNodeGet.name,
  description: graphNodeGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function graphNodeGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(graphNodeGet.name, args, ctx, { surface: "mcp" });
  return toolResult(graphNodeGet.output.parse(output));
}
