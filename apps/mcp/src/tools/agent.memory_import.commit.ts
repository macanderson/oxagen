import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryImportCommit } from "@oxagen/oxagen/contracts/agent.memory_import.commit";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentMemoryImportCommit.input.shape,
  drafts: agentMemoryImportCommit.input.shape.drafts.describe(
    "The confirmed draft memories to persist (max 200 per call)",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMemoryImportCommit.name,
  description: agentMemoryImportCommit.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentMemoryImportCommitTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMemoryImportCommit.name, args, ctx, {
    surface: "mcp",
  });
  return agentMemoryImportCommit.output.parse(output);
}
