import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { graphRelationshipUpsert } from "@oxagen/oxagen/contracts/graph.relationship.upsert";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...graphRelationshipUpsert.input.shape,
};

export const metadata: ToolMetadata = {
  name: graphRelationshipUpsert.name,
  description: graphRelationshipUpsert.description,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

export default async function graphRelationshipUpsertTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(graphRelationshipUpsert.name, args, ctx, { surface: "mcp" });
  return graphRelationshipUpsert.output.parse(output);
}
