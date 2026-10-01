import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringMarkdownImportCommit } from "@oxagen/oxagen/contracts/steering.markdown_import.commit";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = steeringMarkdownImportCommit.input.shape;

// It opens a steering PR and changes no production branch. A second call
// opens a second PR on the next branch of the day.
export const metadata: ToolMetadata = {
  name: steeringMarkdownImportCommit.name,
  description: steeringMarkdownImportCommit.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function commitMarkdownImportTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringMarkdownImportCommit.name, args, ctx, {
    surface: "mcp",
  });
  return steeringMarkdownImportCommit.output.parse(output);
}
