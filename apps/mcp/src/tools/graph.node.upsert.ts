import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { graphNodeUpsert } from "@oxagen/oxagen/contracts/graph.node.upsert";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...graphNodeUpsert.input.shape,
  label: graphNodeUpsert.input.shape.label.describe(
    "User-defined node type, e.g. Person, Company, Topic",
  ),
  displayName: graphNodeUpsert.input.shape.displayName.describe(
    "Human-readable name for the node",
  ),
  description: graphNodeUpsert.input.shape.description.describe(
    "Optional description or summary (max 2000 chars)",
  ),
  properties: graphNodeUpsert.input.shape.properties.describe(
    "Arbitrary key-value metadata to store on the node",
  ),
  externalId: graphNodeUpsert.input.shape.externalId.describe(
    "Stable user-supplied identifier for MERGE deduplication; if absent the natural key (label+displayName+workspaceId) is used",
  ),
};

export const metadata: ToolMetadata = {
  name: graphNodeUpsert.name,
  description: graphNodeUpsert.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function graphNodeUpsertTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(graphNodeUpsert.name, args, ctx, { surface: "mcp" });
  return graphNodeUpsert.output.parse(output);
}
