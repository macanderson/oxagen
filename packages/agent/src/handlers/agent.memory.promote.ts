import type { CapabilityContext } from "../types";
import { promoteMemory } from "../memory/neo4j";
import { isKnowledgeGraphEnabled } from "../runtime/knowledge-graph";
import { assertMemoryClassInvariants } from "@oxagen/oxagen/contracts/agent.memory.model";
import type {
  AgentMemoryPromoteInput,
  AgentMemoryPromoteOutput,
} from "@oxagen/oxagen/contracts/agent.memory.promote";

export type { AgentMemoryPromoteInput, AgentMemoryPromoteOutput };

/**
 * agent.memory.promote — move a memory up the confidence ladder
 * (OBSERVATION → RULE, or RULE → FACT), recording an auditable :Promotion event
 * (docs/specs/two-axis-memory §4). FACT requires human confirmation: the
 * handler re-derives confirmed_by from the *caller* (ctx.userId), since only the
 * handler — not the contract shape — knows who is actually confirming.
 */
export async function agentMemoryPromoteHandler(
  input: AgentMemoryPromoteInput,
  ctx: CapabilityContext,
): Promise<AgentMemoryPromoteOutput> {
  if (!isKnowledgeGraphEnabled()) {
    throw new Error(
      "Knowledge graph is not configured; agent.memory.promote has no store to write to.",
    );
  }

  const invariants = assertMemoryClassInvariants({
    memoryClass: input.toClass,
    enforcementScore: input.enforcementScore ?? null,
    confirmedByKind: input.toClass === "FACT" ? "USER" : null,
    confirmedById: input.toClass === "FACT" ? ctx.userId : null,
  });

  const updated = await promoteMemory({
    memoryId: input.memoryId,
    toClass: input.toClass,
    enforcementScore: invariants.enforcementScore,
    // A promotion invoked by a human session records USER; a background/agent
    // caller (no userId in scope) records AGENT.
    promotedByKind: ctx.userId ? "USER" : "AGENT",
    promotedById: ctx.userId,
    // Rationale is optional on the contract; store null on the :Promotion when absent.
    rationale: input.rationale ?? null,
    confirmedById: invariants.confirmedById,
    basedOnEvidenceIds: input.basedOnEvidenceIds,
  });

  if (!updated) {
    throw new Error(`Memory ${input.memoryId} not found in this workspace.`);
  }

  return updated;
}
