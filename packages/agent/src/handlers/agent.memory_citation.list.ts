import type { CapabilityContext } from "../types";
import { listExecutionCitations } from "../memory/neo4j";
import { isKnowledgeGraphEnabled } from "../runtime/knowledge-graph";
import type {
  AgentMemoryCitationsListInput,
  AgentMemoryCitationsListOutput,
} from "@oxagen/oxagen/contracts/agent.memory_citation.list";

export type { AgentMemoryCitationsListInput, AgentMemoryCitationsListOutput };

/**
 * agent.memory.citations.list — list the memory citations recorded for an
 * execution (docs/specs/two-axis-memory §7d/§7e), optionally filtered by
 * compliance (e.g. VIOLATION) or influence (e.g. DECISIVE/CONTRIBUTING).
 */
export async function agentMemoryCitationsListHandler(
  input: AgentMemoryCitationsListInput,
  _ctx: CapabilityContext,
): Promise<AgentMemoryCitationsListOutput> {
  if (!isKnowledgeGraphEnabled()) {
    return { citations: [] };
  }
  const citations = await listExecutionCitations({
    executionId: input.executionId,
    compliance: input.compliance,
    influenceIn: input.influenceIn,
  });
  return { citations };
}
