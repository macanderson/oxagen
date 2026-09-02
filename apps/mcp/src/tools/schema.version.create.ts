import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { schemaVersionCreate } from "@oxagen/oxagen/contracts/schema.version.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...schemaVersionCreate.input.shape,
};

export const metadata: ToolMetadata = {
  name: schemaVersionCreate.name,
  description: schemaVersionCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function schemaVersionCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(schemaVersionCreate.name, args, ctx, {
    surface: "mcp",
  });
  return schemaVersionCreate.output.parse(output);
}
