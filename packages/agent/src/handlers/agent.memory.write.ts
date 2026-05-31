import type { CapabilityContext } from "../types.js";
import { writeMemory } from "../memory/neo4j.js";
import { embedText } from "../memory/embed.js";
import type { AgentMemoryWriteInput, AgentMemoryWriteOutput } from "@oxagen/oxagen/contracts/agent.memory.write";

export type { AgentMemoryWriteInput, AgentMemoryWriteOutput };

export async function agentMemoryWriteHandler(
  input: AgentMemoryWriteInput,
  ctx: CapabilityContext,
): Promise<AgentMemoryWriteOutput> {
  const embedding = await embedText(input.lesson);
  const { memoryId } = await writeMemory({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    nodeRef: input.nodeRef,
    embedding,
    weight: input.weight,
    kind: input.kind,
    lesson: input.lesson,
    source: input.source,
  });
  return { memoryId, nodeRef: input.nodeRef };
}
