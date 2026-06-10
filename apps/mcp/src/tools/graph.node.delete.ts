import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { graphNodeDelete } from "@oxagen/oxagen/contracts/graph.node.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  nodeId: graphNodeDelete.input.shape.nodeId.describe("publicId of the KnowledgeNode to delete"),
};

export const metadata: ToolMetadata = {
  name: graphNodeDelete.name,
  description: graphNodeDelete.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function graphNodeDeleteTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(graphNodeDelete.name, args, ctx, { surface: "mcp" });
  return graphNodeDelete.output.parse(output);
}
