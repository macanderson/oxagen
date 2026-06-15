import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { ontologyNeighbors } from "@oxagen/oxagen/contracts/ontology.neighbors";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...ontologyNeighbors.input.shape,
  nodeId: ontologyNeighbors.input.shape.nodeId.describe(
    "publicId of the node whose one-hop neighbors to fetch",
  ),
  edgeTypes: ontologyNeighbors.input.shape.edgeTypes.describe(
    "Relationship type(s) to include; omit to include all types",
  ),
  direction: ontologyNeighbors.input.shape.direction.describe(
    "Which neighbors to return relative to the node: 'out', 'in', or 'both'",
  ),
};

export const metadata: ToolMetadata = {
  name: ontologyNeighbors.name,
  description: ontologyNeighbors.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function ontologyNeighborsTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(ontologyNeighbors.name, args, ctx, { surface: "mcp" });
  return ontologyNeighbors.output.parse(output);
}
