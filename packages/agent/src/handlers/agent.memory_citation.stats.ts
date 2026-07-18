import type { CapabilityContext } from "../types";
import { readCitationStats } from "../memory/neo4j";
import { isKnowledgeGraphEnabled } from "../runtime/knowledge-graph";
import type {
  AgentMemoryCitationStatsInput,
  AgentMemoryCitationStatsOutput,
} from "@oxagen/oxagen/contracts/agent.memory_citation.stats";

export type { AgentMemoryCitationStatsInput, AgentMemoryCitationStatsOutput };

/** The empty-but-valid rollup returned when no knowledge graph is configured. */
const EMPTY_STATS: AgentMemoryCitationStatsOutput = {
  totals: { citations: 0, executions: 0, memoriesCited: 0, nodesCited: 0 },
  byInfluence: {},
  byCompliance: {},
  daily: [],
  topMemories: [],
  leastUsefulMemories: [],
  mostViolatedRules: [],
  topNodes: [],
};

/**
 * agent.memory.citations.stats — workspace-wide citation analytics across all
 * executions (the cross-execution rollup `list_memory_citations` can't answer).
 * Read-only: when the graph is disabled it returns an empty-but-valid rollup so
 * the Knowledge → Citations dashboard renders zeros rather than erroring
 * (docs/specs/two-axis-memory §6/§7).
 */
export async function agentMemoryCitationStatsHandler(
  input: AgentMemoryCitationStatsInput,
  _ctx: CapabilityContext,
): Promise<AgentMemoryCitationStatsOutput> {
  if (!isKnowledgeGraphEnabled()) {
    return EMPTY_STATS;
  }
  return readCitationStats({ days: input.days, limit: input.limit });
}
