import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { graphIngest } from "@oxagen/oxagen/contracts/graph.ingest";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...graphIngest.input.shape,
  text: graphIngest.input.shape.text.describe(
    "The source text to extract entities and relationships from (max 100k chars).",
  ),
  sourceUrl: graphIngest.input.shape.sourceUrl.describe(
    "Optional provenance URL, stored on the created nodes.",
  ),
  entityTypeHints: graphIngest.input.shape.entityTypeHints.describe(
    "Optional entity types (node labels) to look for; defaults to the workspace graph prompt.",
  ),
  maxEntities: graphIngest.input.shape.maxEntities.describe(
    "Cap on the number of entities to extract (1–50, default 25).",
  ),
};

export const metadata: ToolMetadata = {
  name: graphIngest.name,
  description: graphIngest.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function graphIngestTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(graphIngest.name, args, ctx, { surface: "mcp" });
  return graphIngest.output.parse(output);
}
