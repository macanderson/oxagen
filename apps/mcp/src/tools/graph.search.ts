import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { graphSearch } from "@oxagen/oxagen/contracts/graph.search";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...graphSearch.input.shape,
  query: graphSearch.input.shape.query.describe(
    "Natural-language query to search the knowledge graph by vector similarity",
  ),
  limit: graphSearch.input.shape.limit.describe(
    "Maximum number of results to return (1–50, default 10)",
  ),
  labels: graphSearch.input.shape.labels.describe(
    'Optional domain-label filter (e.g. ["Person", "Company"])',
  ),
};

export const metadata: ToolMetadata = {
  name: graphSearch.name,
  description: graphSearch.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function graphSearchTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(graphSearch.name, args, ctx, { surface: "mcp" });
  return graphSearch.output.parse(output);
}
