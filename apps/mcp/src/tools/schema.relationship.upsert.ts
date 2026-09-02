import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { schemaRelationshipUpsert } from "@oxagen/oxagen/contracts/schema.relationship.upsert";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...schemaRelationshipUpsert.input.shape,
};

export const metadata: ToolMetadata = {
  name: schemaRelationshipUpsert.name,
  description: schemaRelationshipUpsert.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function schemaRelationshipUpsertTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(schemaRelationshipUpsert.name, args, ctx, {
    surface: "mcp",
  });
  return schemaRelationshipUpsert.output.parse(output);
}
