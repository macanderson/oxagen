import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { schemaSetup } from "@oxagen/oxagen/contracts/schema.setup";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  ...schemaSetup.input.shape,
};

export const metadata: ToolMetadata = {
  name: schemaSetup.name,
  description: schemaSetup.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function schemaSetupTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(schemaSetup.name, args, ctx, { surface: "mcp" });
  return toolResult(schemaSetup.output.parse(output));
}
