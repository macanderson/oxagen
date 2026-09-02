import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { schemaValidateNode } from "@oxagen/oxagen/contracts/schema.validate.node";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...schemaValidateNode.input.shape,
};

export const metadata: ToolMetadata = {
  name: schemaValidateNode.name,
  description: schemaValidateNode.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function schemaValidateNodeTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(schemaValidateNode.name, args, ctx, {
    surface: "mcp",
  });
  return schemaValidateNode.output.parse(output);
}
