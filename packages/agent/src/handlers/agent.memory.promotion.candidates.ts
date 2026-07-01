import type { CapabilityContext } from "../types";
import { listPromotionCandidates } from "../memory/neo4j";
import { isKnowledgeGraphEnabled } from "../runtime/knowledge-graph";
import type {
  AgentMemoryPromotionCandidatesInput,
  AgentMemoryPromotionCandidatesOutput,
} from "@oxagen/oxagen/contracts/agent.memory.promotion.candidates";

export type {
  AgentMemoryPromotionCandidatesInput,
  AgentMemoryPromotionCandidatesOutput,
};

/**
 * agent.memory.promotion.candidates — the top OBSERVATIONs by citation pressure
 * that are ripe to promote to RULE/FACT (docs/specs/two-axis-memory §7c). Backs
 * the "promote me" UI surface.
 */
export async function agentMemoryPromotionCandidatesHandler(
  input: AgentMemoryPromotionCandidatesInput,
  _ctx: CapabilityContext,
): Promise<AgentMemoryPromotionCandidatesOutput> {
  if (!isKnowledgeGraphEnabled()) {
    return { candidates: [] };
  }
  const candidates = await listPromotionCandidates({ limit: input.limit });
  return { candidates };
}
