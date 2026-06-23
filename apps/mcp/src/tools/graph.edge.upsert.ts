import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { graphEdgeUpsert } from "@oxagen/oxagen/contracts/graph.edge.upsert";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...graphEdgeUpsert.input.shape,
  fromNodeId: graphEdgeUpsert.input.shape.fromNodeId.describe(
    "publicId of the source KnowledgeNode",
  ),
  toNodeId: graphEdgeUpsert.input.shape.toNodeId.describe(
    "publicId of the target KnowledgeNode",
  ),
  relationshipType: graphEdgeUpsert.input.shape.relationshipType.describe(
    "Relationship type — must match [A-Z][A-Z0-9_]{0,62} (e.g. RELATED_TO, PART_OF, CAUSED_BY)",
  ),
  properties: graphEdgeUpsert.input.shape.properties.describe(
    "Optional string key-value metadata to store on the relationship",
  ),
};

export const metadata: ToolMetadata = {
  name: graphEdgeUpsert.name,
  description: graphEdgeUpsert.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function graphEdgeUpsertTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(graphEdgeUpsert.name, args, ctx, { surface: "mcp" });
  return graphEdgeUpsert.output.parse(output);
}
