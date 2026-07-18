import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * agent.memory.promotion.dismiss — durably remove a memory from the promotion
 * candidate queue so the next-highest-signal OBSERVATION takes its slot.
 *
 * Candidates are a derived ranked window (top ACTIVE OBSERVATIONs by citation
 * pressure), so without a persisted marker a dismissed suggestion reappears on
 * the next load. Dismissal stamps `promotion_dismissed_at` on the node; the
 * memory itself stays ACTIVE and recallable — only the suggestion is silenced.
 * Pass `restore: true` to clear the marker and let the memory re-qualify.
 */
export const agentMemoryPromotionDismiss = registerCapability({
  name: "dismiss_memory_promotion",
  domain: "agent",
  description:
    "Dismiss a memory from the promotion candidate queue (or restore it), freeing the slot for the next candidate without archiving the memory.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "memory" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    memoryId: z
      .string()
      .min(1)
      .describe("The AgentMemory node id (not publicId) to dismiss"),
    restore: z
      .boolean()
      .default(false)
      .describe(
        "Clear a previous dismissal so the memory can appear as a candidate again",
      ),
  }),
  output: z.object({
    memoryId: z.string(),
    dismissed: z
      .boolean()
      .describe(
        "True when the memory is now excluded from promotion candidates",
      ),
  }),
});

export type AgentMemoryPromotionDismissInput = z.output<
  typeof agentMemoryPromotionDismiss.input
>;
export type AgentMemoryPromotionDismissOutput = z.output<
  typeof agentMemoryPromotionDismiss.output
>;
