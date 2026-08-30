import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { schemaList } from "@oxagen/oxagen/contracts/schema.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...schemaList.input.shape,
};

export const metadata: ToolMetadata = {
  name: schemaList.name,
  description: schemaList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function schemaListTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(schemaList.name, args, ctx, { surface: "mcp" });
  return schemaList.output.parse(output);
}
