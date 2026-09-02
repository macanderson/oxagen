import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { schemaLabelDelete } from "@oxagen/oxagen/contracts/schema.label.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...schemaLabelDelete.input.shape,
};

export const metadata: ToolMetadata = {
  name: schemaLabelDelete.name,
  description: schemaLabelDelete.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function schemaLabelDeleteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(schemaLabelDelete.name, args, ctx, {
    surface: "mcp",
  });
  return schemaLabelDelete.output.parse(output);
}
