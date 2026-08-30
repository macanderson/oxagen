import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { ontologyQuery } from "@oxagen/oxagen/contracts/ontology.query";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...ontologyQuery.input.shape,
  startNodeId: ontologyQuery.input.shape.startNodeId.describe(
    "publicId of the node to start the typed traversal from",
  ),
  edgeTypes: ontologyQuery.input.shape.edgeTypes.describe(
    'Relationship type(s) to follow (e.g. ["RELATED_TO", "DEPENDS_ON"]); omit to follow all types',
  ),
  direction: ontologyQuery.input.shape.direction.describe(
    "Direction to traverse: 'out', 'in', or 'both'",
  ),
  maxDepth: ontologyQuery.input.shape.maxDepth.describe(
    "Maximum hop distance to traverse (1–5, default 2)",
  ),
  asOf: ontologyQuery.input.shape.asOf.describe(
    "Valid-time instant (ISO-8601): traverse only edges true in the world at this time; omit for now",
  ),
  asKnownAt: ontologyQuery.input.shape.asKnownAt.describe(
    "Transaction-time instant (ISO-8601): traverse using only what was known/recorded by this time; omit for now",
  ),
};

export const metadata: ToolMetadata = {
  name: ontologyQuery.name,
  description: ontologyQuery.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function ontologyQueryTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(ontologyQuery.name, args, ctx, {
    surface: "mcp",
  });
  return ontologyQuery.output.parse(output);
}
