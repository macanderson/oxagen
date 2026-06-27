import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { graphExport } from "@oxagen/oxagen/contracts/graph.export";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...graphExport.input.shape,
  labels: graphExport.input.shape.labels.describe(
    "Filter by node labels (e.g., [\"Feature\", \"Issue\"]). Omit for all labels.",
  ),
  isSystem: graphExport.input.shape.isSystem.describe(
    "false = customer ontology only; true = system/product nodes only; omit for both.",
  ),
  updatedAfter: graphExport.input.shape.updatedAfter.describe(
    "ISO-8601 high-watermark for incremental sync. Pass the cursor from the previous page.",
  ),
  includeEdges: graphExport.input.shape.includeEdges.describe(
    "Include edges between returned nodes (default true). Set false for a nodes-only export.",
  ),
  limit: graphExport.input.shape.limit.describe(
    "Max nodes per page (1–1000, default 500).",
  ),
  offset: graphExport.input.shape.offset.describe(
    "Zero-based pagination offset (prefer cursor for incremental pulls).",
  ),
};

export const metadata: ToolMetadata = {
  name: graphExport.name,
  description: graphExport.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function graphExportTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(graphExport.name, args, ctx, { surface: "mcp" });
  return graphExport.output.parse(output);
}
