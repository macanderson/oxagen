import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { schemaValidateRelationship } from "@oxagen/oxagen/contracts/schema.validate.relationship";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...schemaValidateRelationship.input.shape,
};

export const metadata: ToolMetadata = {
  name: schemaValidateRelationship.name,
  description: schemaValidateRelationship.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function schemaValidateRelationshipTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(schemaValidateRelationship.name, args, ctx, {
    surface: "mcp",
  });
  return schemaValidateRelationship.output.parse(output);
}
