import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { schemaPropertyUpsert } from "@oxagen/oxagen/contracts/schema.property.upsert";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...schemaPropertyUpsert.input.shape,
};

export const metadata: ToolMetadata = {
  name: schemaPropertyUpsert.name,
  description: schemaPropertyUpsert.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function schemaPropertyUpsertTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(schemaPropertyUpsert.name, args, ctx, {
    surface: "mcp",
  });
  return schemaPropertyUpsert.output.parse(output);
}
