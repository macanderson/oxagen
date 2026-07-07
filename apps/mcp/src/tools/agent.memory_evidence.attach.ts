import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryEvidenceAttach } from "@oxagen/oxagen/contracts/agent.memory_evidence.attach";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentMemoryEvidenceAttach.input.shape,
  memoryId: agentMemoryEvidenceAttach.input.shape.memoryId.describe(
    "The AgentMemory node id (not publicId) to attach evidence to",
  ),
  strength: agentMemoryEvidenceAttach.input.shape.strength.describe(
    "0-1 contribution; confidence moves by strength*100",
  ),
  refutes: agentMemoryEvidenceAttach.input.shape.refutes.describe(
    "true = negative evidence (REFUTES, lowers confidence)",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMemoryEvidenceAttach.name,
  description: agentMemoryEvidenceAttach.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentMemoryEvidenceAttachTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMemoryEvidenceAttach.name, args, ctx, {
    surface: "mcp",
  });
  return agentMemoryEvidenceAttach.output.parse(output);
}
