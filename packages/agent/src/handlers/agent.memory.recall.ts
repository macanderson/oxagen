import type { CapabilityContext } from "../types";
import { recallMemories, reinforceMemory } from "../memory/neo4j";
import { embedText } from "../memory/embed";
import { isKnowledgeGraphEnabled } from "../runtime/knowledge-graph";
import type { AgentMemoryRecallInput, AgentMemoryRecallOutput } from "@oxagen/oxagen/contracts/agent.memory.recall";
import { insertMemoryChange } from "@oxagen/telemetry";

export type { AgentMemoryRecallInput, AgentMemoryRecallOutput };

export async function agentMemoryRecallHandler(
  input: AgentMemoryRecallInput,
  ctx: CapabilityContext,
): Promise<AgentMemoryRecallOutput> {
  if (!isKnowledgeGraphEnabled()) {
    return { memories: [] };
  }
  const embedding = await embedText(input.query, {
    telemetry: {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      surface: ctx.surface,
      executionStepId: ctx.messageId ?? ctx.requestId,
    },
  });
  const memories = await recallMemories({
    embedding,
    minWeight: input.minWeight,
    limit: input.limit,
    nodeRef: input.nodeRef,
  });

  // Fire-and-forget: reinforce each recalled memory and emit a telemetry event.
  // These are not awaited — they must not block the critical recall path.
  const occurredAt = new Date().toISOString();
  for (const m of memories) {
    const confidenceBefore = m.confidence;
    const confidenceAfter = Math.min(confidenceBefore + 0.05, 1.0);

    void reinforceMemory({ memoryId: m.id, reinforcementAmount: 0.05 }).catch((err) => {
      console.warn("reinforceMemory fire-and-forget failed", err);
    });

    void insertMemoryChange({
      change_id: crypto.randomUUID(),
      org_id: ctx.orgId,
      workspace_id: ctx.workspaceId,
      memory_id: m.id,
      node_ref: m.nodeRef,
      cause: "reinforced",
      confidence_before: confidenceBefore,
      confidence_after: confidenceAfter,
      occurred_at: occurredAt,
    }).catch((err) => {
      console.warn("insertMemoryChange fire-and-forget failed", err);
    });
  }

  return { memories };
}
