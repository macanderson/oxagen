import type { CapabilityContext } from "../types.js";
import { recallMemories } from "../memory/neo4j.js";
import { embedText } from "../memory/embed.js";

export interface AgentMemoryRecallInput {
  query: string;
  minWeight: "low" | "high" | "critical";
  limit: number;
  nodeRef?: string;
}

export interface AgentMemoryRecallOutput {
  memories: Array<{
    id: string;
    nodeRef: string;
    weight: "low" | "high" | "critical";
    kind: string;
    lesson: string;
    source: string;
    score: number;
    createdAt: string;
  }>;
}

export async function agentMemoryRecallHandler(
  input: AgentMemoryRecallInput,
  ctx: CapabilityContext,
): Promise<AgentMemoryRecallOutput> {
  const embedding = await embedText(input.query);
  const memories = await recallMemories({
    tenantId: ctx.tenantId,
    workspaceId: ctx.workspaceId,
    embedding,
    minWeight: input.minWeight,
    limit: input.limit,
    nodeRef: input.nodeRef,
  });
  return { memories };
}
