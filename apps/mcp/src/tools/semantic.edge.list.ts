import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { semanticEdgeList } from "@oxagen/oxagen/contracts/semantic.edge.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...semanticEdgeList.input.shape,
  type: semanticEdgeList.input.shape.type.describe(
    "Filter to edges of this relationship type.",
  ),
  sourceId: semanticEdgeList.input.shape.sourceId.describe(
    "Filter to edges whose source node originates from this connector sourceId.",
  ),
  confidenceMin: semanticEdgeList.input.shape.confidenceMin.describe(
    "Return only edges with confidence >= this value.",
  ),
  confidenceMax: semanticEdgeList.input.shape.confidenceMax.describe(
    "Return only edges with confidence <= this value.",
  ),
  limit: semanticEdgeList.input.shape.limit.describe(
    "Maximum results per page (1–250, default 50).",
  ),
  offset: semanticEdgeList.input.shape.offset.describe(
    "Zero-based page offset.",
  ),
};

export const metadata: ToolMetadata = {
  name: semanticEdgeList.name,
  description: semanticEdgeList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function semanticEdgeListTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(semanticEdgeList.name, args, ctx, { surface: "mcp" });
  return semanticEdgeList.output.parse(output);
}
