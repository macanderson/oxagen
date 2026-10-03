import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { secretExport } from "@oxagen/oxagen/contracts/secret.export";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  ...secretExport.input.shape,
};

export const metadata: ToolMetadata = {
  name: secretExport.name,
  description: secretExport.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function secretExportTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(secretExport.name, args, ctx, { surface: "mcp" });
  return toolResult(secretExport.output.parse(output));
}
