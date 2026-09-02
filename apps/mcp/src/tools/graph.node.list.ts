import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { graphNodeList } from "@oxagen/oxagen/contracts/graph.node.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...graphNodeList.input.shape,
  labels: graphNodeList.input.shape.labels.describe(
    'Filter by node labels (e.g., ["Feature", "Issue"])',
  ),
  sourceId: graphNodeList.input.shape.sourceId.describe(
    "Filter by source connector ID",
  ),
  limit: graphNodeList.input.shape.limit.describe(
    "Max results per page (1–250, default 50)",
  ),
  offset: graphNodeList.input.shape.offset.describe(
    "Zero-based pagination offset",
  ),
  query: graphNodeList.input.shape.query.describe(
    "Text search in displayName and description",
  ),
};

export const metadata: ToolMetadata = {
  name: graphNodeList.name,
  description: graphNodeList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function graphNodeListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(graphNodeList.name, args, ctx, {
    surface: "mcp",
  });
  return graphNodeList.output.parse(output);
}
