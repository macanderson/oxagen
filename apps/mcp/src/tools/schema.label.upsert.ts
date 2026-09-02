import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { schemaLabelUpsert } from "@oxagen/oxagen/contracts/schema.label.upsert";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...schemaLabelUpsert.input.shape,
};

export const metadata: ToolMetadata = {
  name: schemaLabelUpsert.name,
  description: schemaLabelUpsert.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function schemaLabelUpsertTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(schemaLabelUpsert.name, args, ctx, {
    surface: "mcp",
  });
  return schemaLabelUpsert.output.parse(output);
}
