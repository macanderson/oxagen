import type { CapabilityContext } from "../types";
import { recallMemories, reinforceMemory } from "../memory/neo4j";
import { embedText } from "../memory/embed";
import { isKnowledgeGraphEnabled } from "../runtime/knowledge-graph";
import type { AgentMemoryRecallInput, AgentMemoryRecallOutput } from "@oxagen/oxagen/contracts/agent.memory.recall";
import { insertMemoryChange } from "@oxagen/telemetry";

export type { AgentMemoryRecallInput, AgentMemoryRecallOutput };

// Fixed recovery bump per recall citation, on the 0-100 confidence_score scale
// (mirrors the legacy 0.05 bump on the pre-two-axis 0-1 `confidence` scale).
const RECALL_REINFORCEMENT_AMOUNT = 5;

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
  const rows = await recallMemories({
    embedding,
    limit: input.limit,
    nodeRef: input.nodeRef,
    memoryClass: input.memoryClass,
    minEnforcement: input.minEnforcement,
  });

  // Fire-and-forget: reinforce each recalled memory and emit a telemetry event.
  // These are not awaited — they must not block the critical recall path.
  const occurredAt = new Date().toISOString();
  for (const m of rows) {
    const confidenceBefore = m.confidenceScore;
    const confidenceAfter = Math.min(confidenceBefore + RECALL_REINFORCEMENT_AMOUNT, 100);

    void reinforceMemory({ memoryId: m.id, reinforcementAmount: RECALL_REINFORCEMENT_AMOUNT }).catch((err) => {
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

  return {
    memories: rows.map((m) => ({
      id: m.id,
      nodeRef: m.nodeRef,
      memoryClass: m.memoryClass,
      memoryKind: m.memoryKind,
      lesson: m.lesson,
      source: m.source,
      confidenceScore: m.confidenceScore,
      enforcementScore: m.enforcementScore,
      score: m.score,
      createdAt: m.createdAt,
    })),
  };
}
