import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { graphNodeSearch } from "@oxagen/oxagen/contracts/graph.node.search";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...graphNodeSearch.input.shape,
  query: graphNodeSearch.input.shape.query.describe(
    "Text to search for in node displayName or description",
  ),
  labels: graphNodeSearch.input.shape.labels.describe(
    'Optional list of node labels to restrict the search to (e.g. ["Person", "Company"])',
  ),
  limit: graphNodeSearch.input.shape.limit.describe(
    "Maximum number of results to return (1–50, default 10)",
  ),
};

export const metadata: ToolMetadata = {
  name: graphNodeSearch.name,
  description: graphNodeSearch.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function graphNodeSearchTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(graphNodeSearch.name, args, ctx, {
    surface: "mcp",
  });
  return graphNodeSearch.output.parse(output);
}
