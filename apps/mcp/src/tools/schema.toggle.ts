import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { schemaToggle } from "@oxagen/oxagen/contracts/schema.toggle";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...schemaToggle.input.shape,
};

export const metadata: ToolMetadata = {
  name: schemaToggle.name,
  description: schemaToggle.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function schemaToggleTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(schemaToggle.name, args, ctx, { surface: "mcp" });
  return schemaToggle.output.parse(output);
}
