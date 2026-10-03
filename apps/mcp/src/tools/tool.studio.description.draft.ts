import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolStudioDescriptionDraft } from "@oxagen/oxagen/contracts/tool.studio.description.draft";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  server: toolStudioDescriptionDraft.input.shape.server.describe(
    "The server folder under tools/servers/ that holds the tool",
  ),
  tool: toolStudioDescriptionDraft.input.shape.tool.describe(
    "The tool's tools.toml key, the name the agent sees, or the upstream name it selects. A tool the source offers and the folder has not imported works too",
  ),
};

export const metadata: ToolMetadata = {
  name: toolStudioDescriptionDraft.name,
  description: toolStudioDescriptionDraft.description,
  annotations: {
    // It saves nothing. Each call asks the model again, so two calls can differ.
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function toolStudioDescriptionDraftTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolStudioDescriptionDraft.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(toolStudioDescriptionDraft.output.parse(output));
}
