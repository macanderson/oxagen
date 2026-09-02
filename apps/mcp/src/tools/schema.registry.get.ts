import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { schemaRegistryGet } from "@oxagen/oxagen/contracts/schema.registry.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...schemaRegistryGet.input.shape,
};

export const metadata: ToolMetadata = {
  name: schemaRegistryGet.name,
  description: schemaRegistryGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function schemaRegistryGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(schemaRegistryGet.name, args, ctx, {
    surface: "mcp",
  });
  return schemaRegistryGet.output.parse(output);
}
