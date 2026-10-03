import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringMarkdownImportParse } from "@oxagen/oxagen/contracts/steering.markdown_import.parse";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = steeringMarkdownImportParse.input.shape;

// It writes nothing. Each call spends one model call per file it splits, and
// the model may split the same file differently twice.
export const metadata: ToolMetadata = {
  name: steeringMarkdownImportParse.name,
  description: steeringMarkdownImportParse.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function parseMarkdownImportTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringMarkdownImportParse.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(steeringMarkdownImportParse.output.parse(output));
}
