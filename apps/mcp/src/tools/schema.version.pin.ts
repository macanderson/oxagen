import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { schemaVersionPin } from "@oxagen/oxagen/contracts/schema.version.pin";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...schemaVersionPin.input.shape,
};

export const metadata: ToolMetadata = {
  name: schemaVersionPin.name,
  description: schemaVersionPin.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function schemaVersionPinTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(schemaVersionPin.name, args, ctx, {
    surface: "mcp",
  });
  return schemaVersionPin.output.parse(output);
}
