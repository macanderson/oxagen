import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryImportParse } from "@oxagen/oxagen/contracts/agent.memory_import.parse";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentMemoryImportParse.input.shape,
  documents: agentMemoryImportParse.input.shape.documents.describe(
    "Uploaded markdown documents to extract memories from (max 25 per call)",
  ),
  defaultNodeRef: agentMemoryImportParse.input.shape.defaultNodeRef.describe(
    "Graph node id to anchor every extracted draft on; defaults to the user-memory bucket",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMemoryImportParse.name,
  description: agentMemoryImportParse.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentMemoryImportParseTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMemoryImportParse.name, args, ctx, {
    surface: "mcp",
  });
  return agentMemoryImportParse.output.parse(output);
}
