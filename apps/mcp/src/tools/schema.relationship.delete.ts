import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { schemaRelationshipDelete } from "@oxagen/oxagen/contracts/schema.relationship.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...schemaRelationshipDelete.input.shape,
};

export const metadata: ToolMetadata = {
  name: schemaRelationshipDelete.name,
  description: schemaRelationshipDelete.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function schemaRelationshipDeleteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(schemaRelationshipDelete.name, args, ctx, {
    surface: "mcp",
  });
  return schemaRelationshipDelete.output.parse(output);
}
