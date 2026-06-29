import type { CapabilityContext } from "../types";
import { deleteMemory } from "../memory/neo4j";
import { isKnowledgeGraphEnabled } from "../runtime/knowledge-graph";
import type {
  AgentMemoryDeleteInput,
  AgentMemoryDeleteOutput,
} from "@oxagen/oxagen/contracts/agent.memory.delete";

export type { AgentMemoryDeleteInput, AgentMemoryDeleteOutput };

export async function agentMemoryDeleteHandler(
  input: AgentMemoryDeleteInput,
  _ctx: CapabilityContext,
): Promise<AgentMemoryDeleteOutput> {
  // No graph configured → nothing to delete; report deleted:false rather than
  // throwing, consistent with the no-op posture of the other memory handlers.
  if (!isKnowledgeGraphEnabled()) {
    return { deleted: false, memoryId: input.memoryId };
  }
  const deleted = await deleteMemory({ memoryId: input.memoryId });
  return { deleted, memoryId: input.memoryId };
}
