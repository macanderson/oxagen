import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolStudioSelectionRun } from "@oxagen/oxagen/contracts/tool.studio.selection.run";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  server: toolStudioSelectionRun.input.shape.server.describe(
    "The server folder under tools/servers/ whose tests/selection.jsonl the run asks the model about",
  ),
};

export const metadata: ToolMetadata = {
  name: toolStudioSelectionRun.name,
  description: toolStudioSelectionRun.description,
  annotations: {
    // It saves nothing. Each run asks the model again, so two runs can differ.
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function toolStudioSelectionRunTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolStudioSelectionRun.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(toolStudioSelectionRun.output.parse(output));
}
