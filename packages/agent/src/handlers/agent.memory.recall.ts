import type { CapabilityContext } from "../types.js";
import { recallMemories } from "../memory/neo4j.js";
import { embedText } from "../memory/embed.js";
import type { AgentMemoryRecallInput, AgentMemoryRecallOutput } from "@oxagen/oxagen/contracts/agent.memory.recall";

export type { AgentMemoryRecallInput, AgentMemoryRecallOutput };

export async function agentMemoryRecallHandler(
  input: AgentMemoryRecallInput,
  ctx: CapabilityContext,
): Promise<AgentMemoryRecallOutput> {
  const embedding = await embedText(input.query);
  const memories = await recallMemories({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    embedding,
    minWeight: input.minWeight,
    limit: input.limit,
    nodeRef: input.nodeRef,
  });
  return { memories };
}
