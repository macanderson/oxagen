import type { CapabilityContext } from "../types";
import { demoteMemory } from "../memory/neo4j";
import { isKnowledgeGraphEnabled } from "../runtime/knowledge-graph";
import type {
  AgentMemoryDemoteInput,
  AgentMemoryDemoteOutput,
} from "@oxagen/oxagen/contracts/agent.memory.demote";

export type { AgentMemoryDemoteInput, AgentMemoryDemoteOutput };

/**
 * agent.memory.demote — move a memory down the confidence ladder
 * (FACT → RULE / OBSERVATION, RULE → OBSERVATION), recording an auditable
 * :Demotion event (docs/specs/two-axis-memory §4). The inverse of promote.
 * Direction, enforcement invariants, and clearing FACT's human-confirmation
 * fields are enforced in `demoteMemory`; the handler only supplies principal
 * attribution (a human session records USER, a background caller AGENT).
 */
export async function agentMemoryDemoteHandler(
  input: AgentMemoryDemoteInput,
  ctx: CapabilityContext,
): Promise<AgentMemoryDemoteOutput> {
  if (!isKnowledgeGraphEnabled()) {
    throw new Error(
      "Knowledge graph is not configured; agent.memory.demote has no store to write to.",
    );
  }

  const updated = await demoteMemory({
    memoryId: input.memoryId,
    toClass: input.toClass,
    enforcementScore: input.enforcementScore ?? null,
    demotedByKind: ctx.userId ? "USER" : "AGENT",
    demotedById: ctx.userId,
    rationale: input.rationale ?? null,
  });

  if (!updated) {
    throw new Error(`Memory ${input.memoryId} not found in this workspace.`);
  }

  return updated;
}
