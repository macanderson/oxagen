import type { CapabilityContext } from "../types";
import { writeMemory } from "../memory/neo4j";
import type { ActorKind } from "../memory/neo4j";
import { embedText } from "../memory/embed";
import { isKnowledgeGraphEnabled } from "../runtime/knowledge-graph";
import { assertMemoryClassInvariants } from "@oxagen/oxagen/contracts/agent.memory.model";
import type {
  AgentMemoryWriteInput,
  AgentMemoryWriteOutput,
} from "@oxagen/oxagen/contracts/agent.memory.write";

export type { AgentMemoryWriteInput, AgentMemoryWriteOutput };

/** `source` "user" is a human-provenance write; everything else is agent-provenance. */
function createdByKindFromSource(source: string): ActorKind {
  return source === "user" ? "USER" : "AGENT";
}

export async function agentMemoryWriteHandler(
  input: AgentMemoryWriteInput,
  ctx: CapabilityContext,
): Promise<AgentMemoryWriteOutput> {
  if (!isKnowledgeGraphEnabled()) {
    // No-op when the knowledge graph is not configured. Return a valid output
    // conforming to the contract schema (memoryId is an empty string sentinel
    // that callers can detect; the nodeRef echo is always safe to return).
    return { memoryId: "", nodeRef: input.nodeRef, edgesCreated: 0 };
  }

  // Enforces class↔enforcement↔confirmation invariants (docs/specs/two-axis-memory)
  // before anything touches the graph. `write` has no confirmedBy* fields on its
  // contract, so a caller pinning memoryClass FACT here always throws — FACT is
  // only reachable via agent.memory.promote, which does carry human confirmation.
  const invariants = assertMemoryClassInvariants({
    memoryClass: input.memoryClass,
    enforcementScore: input.enforcementScore ?? null,
  });

  const embedding = await embedText(input.lesson, {
    telemetry: {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      surface: ctx.surface,
      executionStepId: ctx.messageId ?? ctx.requestId,
    },
  });
  const { memoryId, edgesCreated } = await writeMemory({
    nodeRef: input.nodeRef,
    embedding,
    memoryClass: invariants.memoryClass,
    memoryKind: input.memoryKind,
    enforcementScore: invariants.enforcementScore,
    lesson: input.lesson,
    source: input.source,
    createdByKind: createdByKindFromSource(input.source),
    createdById: input.source,
    confirmedByKind: invariants.confirmedByKind,
    confirmedById: invariants.confirmedById,
    relatedNodeIds: input.relatedNodeIds,
  });
  return { memoryId, nodeRef: input.nodeRef, edgesCreated };
}
