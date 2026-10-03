import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { schemaExport } from "@oxagen/oxagen/contracts/schema.export";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  ...schemaExport.input.shape,
};

export const metadata: ToolMetadata = {
  name: schemaExport.name,
  description: schemaExport.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function schemaExportTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(schemaExport.name, args, ctx, { surface: "mcp" });
  return toolResult(schemaExport.output.parse(output));
}
