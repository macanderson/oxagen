import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import {
  markdownImportCommitFields,
  steeringMarkdownImportCommit,
} from "@oxagen/oxagen/contracts/steering.markdown_import.commit";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

// The contract refines its object (at most 299 files in one steering PR), so
// the tool lists the object's own fields and the kernel applies the
// refinement when it parses the call.
export const schema = markdownImportCommitFields;

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
  return toolResult(steeringMarkdownImportCommit.output.parse(output));
}
