import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { semanticEdgeApprove } from "@oxagen/oxagen/contracts/semantic.edge.approve";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...semanticEdgeApprove.input.shape,
  edgeId: semanticEdgeApprove.input.shape.edgeId.describe(
    "UUID of the InferredEdge node to approve or reject.",
  ),
  decision: semanticEdgeApprove.input.shape.decision.describe(
    "'approve' materialises the edge as a permanent knowledge-graph relationship; 'reject' dismisses it with an audit trail.",
  ),
  comment: semanticEdgeApprove.input.shape.comment.describe(
    "Optional reviewer note attached to the edge for audit purposes (max 1000 chars).",
  ),
};

export const metadata: ToolMetadata = {
  name: semanticEdgeApprove.name,
  description: semanticEdgeApprove.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function semanticEdgeApproveTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(semanticEdgeApprove.name, args, ctx, { surface: "mcp" });
  return semanticEdgeApprove.output.parse(output);
}
