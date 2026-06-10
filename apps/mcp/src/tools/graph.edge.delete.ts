import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { graphEdgeDelete } from "@oxagen/oxagen/contracts/graph.edge.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...graphEdgeDelete.input.shape,
  fromNodeId: graphEdgeDelete.input.shape.fromNodeId.describe(
    "publicId of the source KnowledgeNode",
  ),
  toNodeId: graphEdgeDelete.input.shape.toNodeId.describe(
    "publicId of the target KnowledgeNode",
  ),
  edgeType: graphEdgeDelete.input.shape.edgeType.describe(
    "Type of relationship to delete: RELATED_TO | PART_OF | CAUSED_BY | REFERENCES | SIMILAR_TO | DEPENDS_ON | CREATED_BY | MENTIONS",
  ),
};

export const metadata: ToolMetadata = {
  name: graphEdgeDelete.name,
  description: graphEdgeDelete.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function graphEdgeDeleteTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(graphEdgeDelete.name, args, ctx, { surface: "mcp" });
  return graphEdgeDelete.output.parse(output);
}
