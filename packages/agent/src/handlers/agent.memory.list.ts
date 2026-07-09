import type { CapabilityContext } from "../types";
import { listMemories } from "../memory/neo4j";
import { isKnowledgeGraphEnabled } from "../runtime/knowledge-graph";
import type {
  AgentMemoryListInput,
  AgentMemoryListOutput,
} from "@oxagen/oxagen/contracts/agent.memory.list";

export type { AgentMemoryListInput, AgentMemoryListOutput };

export async function agentMemoryListHandler(
  input: AgentMemoryListInput,
  _ctx: CapabilityContext,
): Promise<AgentMemoryListOutput> {
  // When the knowledge graph isn't configured there are no AgentMemory nodes
  // to enumerate — return an empty, schema-valid page rather than throwing.
  if (!isKnowledgeGraphEnabled()) {
    return { memories: [], total: 0 };
  }
  const { memories, total } = await listMemories({
    limit: input.limit,
    offset: input.offset,
    nodeRef: input.nodeRef,
    memoryClass: input.memoryClass,
    memoryKind: input.memoryKind,
    minEnforcement: input.minEnforcement,
    minCitations: input.minCitations,
    sort: input.sort,
    sortDir: input.sortDir,
  });
  return { memories, total };
}
