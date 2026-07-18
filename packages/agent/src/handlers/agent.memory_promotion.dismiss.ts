import type { CapabilityContext } from "../types";
import { dismissPromotion } from "../memory/neo4j";
import { isKnowledgeGraphEnabled } from "../runtime/knowledge-graph";
import type {
  AgentMemoryPromotionDismissInput,
  AgentMemoryPromotionDismissOutput,
} from "@oxagen/oxagen/contracts/agent.memory_promotion.dismiss";

export type {
  AgentMemoryPromotionDismissInput,
  AgentMemoryPromotionDismissOutput,
};

/**
 * agent.memory.promotion.dismiss — stamp (or clear) `promotion_dismissed_at` on
 * a memory so it drops out of the promotion-candidate window, freeing the slot
 * for the next-highest OBSERVATION. The memory stays ACTIVE and recallable; only
 * the suggestion is silenced (docs/specs/two-axis-memory §7c).
 */
export async function agentMemoryPromotionDismissHandler(
  input: AgentMemoryPromotionDismissInput,
  _ctx: CapabilityContext,
): Promise<AgentMemoryPromotionDismissOutput> {
  if (!isKnowledgeGraphEnabled()) {
    throw new Error(
      "Knowledge graph is not configured; agent.memory.promotion.dismiss has no store to write to.",
    );
  }

  const result = await dismissPromotion({
    memoryId: input.memoryId,
    restore: input.restore,
  });

  if (!result) {
    throw new Error(`Memory ${input.memoryId} not found in this workspace.`);
  }

  return result;
}
