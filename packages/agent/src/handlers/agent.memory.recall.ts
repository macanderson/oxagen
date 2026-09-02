import pino from "pino";
import type { CapabilityContext } from "../types";
import {
  recallMemories,
  reinforceMemory,
  recordExecution,
  recordCitation,
} from "../memory/neo4j";
import { embedText } from "../memory/embed";
import { isKnowledgeGraphEnabled } from "../runtime/knowledge-graph";
import type {
  AgentMemoryRecallInput,
  AgentMemoryRecallOutput,
} from "@oxagen/oxagen/contracts/agent.memory.recall";
import { deriveCompliance } from "@oxagen/oxagen/contracts/agent.memory.model";
import { insertMemoryChange } from "@oxagen/telemetry";

export type { AgentMemoryRecallInput, AgentMemoryRecallOutput };

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "recall_memory" },
});

// Fixed recovery bump per recall citation, on the 0-100 confidence_score scale.
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
    const confidenceAfter = Math.min(
      confidenceBefore + RECALL_REINFORCEMENT_AMOUNT,
      100,
    );

    void reinforceMemory({
      memoryId: m.id,
      reinforcementAmount: RECALL_REINFORCEMENT_AMOUNT,
    }).catch((err) => {
      logger.warn(
        { err, memoryId: m.id },
        "reinforceMemory fire-and-forget failed",
      );
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
      logger.warn(
        { err, memoryId: m.id },
        "insertMemoryChange fire-and-forget failed",
      );
    });
  }

  // Opt-in automatic citation: when the caller passes an executionRef (the agent
  // runtime does this per turn), MERGE the :Execution and record a CONSIDERED
  // citation of every recalled memory. We only know the memory was retrieved and
  // considered — not whether it was decisive — so influence is CONSIDERED and
  // deviated is false (compliance derives to NA for observations, COMPLIED for
  // rules). This is the citation pressure that feeds agent.memory.promotion.candidates.
  // Fully fire-and-forget: it must never block or fail the recall path.
  if (input.executionRef) {
    const executionRef = input.executionRef;
    void (async () => {
      try {
        const { executionId } = await recordExecution({
          executionRef,
          agentId: input.agentId ?? null,
          taskSummary: input.query.slice(0, 500),
        });
        await Promise.all(
          rows.map((m) =>
            recordCitation({
              executionId,
              memoryId: m.id,
              influence: "CONSIDERED",
              compliance: deriveCompliance({
                enforcement: m.enforcementScore,
                deviated: false,
              }),
              enforcementAtCite: m.enforcementScore,
              confidenceAtCite: m.confidenceScore,
            }),
          ),
        );
      } catch (err) {
        logger.warn(
          { err, executionRef },
          "recall auto-citation fire-and-forget failed",
        );
      }
    })();
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
