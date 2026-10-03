import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { schemaRegistryConfig } from "@oxagen/oxagen/contracts/schema.registry.config";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  ...schemaRegistryConfig.input.shape,
};

export const metadata: ToolMetadata = {
  name: schemaRegistryConfig.name,
  description: schemaRegistryConfig.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function schemaRegistryConfigTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(schemaRegistryConfig.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(schemaRegistryConfig.output.parse(output));
}
