import type { CapabilityContext } from "../types";
import { attachEvidence } from "../memory/neo4j";
import { isKnowledgeGraphEnabled } from "../runtime/knowledge-graph";
import type {
  AgentMemoryEvidenceAttachInput,
  AgentMemoryEvidenceAttachOutput,
} from "@oxagen/oxagen/contracts/agent.memory_evidence.attach";

export type { AgentMemoryEvidenceAttachInput, AgentMemoryEvidenceAttachOutput };

/**
 * agent.memory.evidence.attach — attach a corroborating (or refuting) :Evidence
 * node to a memory and adjust its confidence (docs/specs/two-axis-memory §5/§7b).
 * This is how confidence recovers between decay passes.
 */
export async function agentMemoryEvidenceAttachHandler(
  input: AgentMemoryEvidenceAttachInput,
  _ctx: CapabilityContext,
): Promise<AgentMemoryEvidenceAttachOutput> {
  if (!isKnowledgeGraphEnabled()) {
    throw new Error(
      "Knowledge graph is not configured; agent.memory.evidence.attach has no store to write to.",
    );
  }

  const result = await attachEvidence({
    memoryId: input.memoryId,
    sourceKind: input.sourceKind,
    strength: input.strength,
    detail: input.detail,
    refutes: input.refutes,
  });

  if (!result) {
    throw new Error(`Memory ${input.memoryId} not found in this workspace.`);
  }

  return result;
}
