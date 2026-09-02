import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { schemaPropertyDelete } from "@oxagen/oxagen/contracts/schema.property.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...schemaPropertyDelete.input.shape,
};

export const metadata: ToolMetadata = {
  name: schemaPropertyDelete.name,
  description: schemaPropertyDelete.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function schemaPropertyDeleteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(schemaPropertyDelete.name, args, ctx, {
    surface: "mcp",
  });
  return schemaPropertyDelete.output.parse(output);
}
