import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * agent.memory.promotion.rationales — draft candidate rationales for a
 * promotion (or demotion) so the human can pick one instead of typing.
 *
 * Loads the memory's lesson, kind, class, and citation/evidence signals and
 * asks a low-cost model (via @oxagen/ai, metered) for short, context-grounded
 * reasons. The rationale itself stays optional on promote/demote — this only
 * removes the typing friction when the user wants one recorded.
 */
export const agentMemoryPromotionRationales = registerCapability({
  name: "suggest_promotion_rationales",
  domain: "agent",
  description:
    "Suggest short, context-grounded rationales for promoting or demoting a memory, drafted by a low-cost model from the memory's lesson and citation signals.",
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
      .describe(
        "The AgentMemory node id (not publicId) being promoted or demoted",
      ),
    toClass: z
      .enum(["RULE", "FACT", "OBSERVATION"])
      .describe(
        "The class change being considered (promotion or demotion target)",
      ),
    count: z
      .number()
      .int()
      .min(2)
      .max(6)
      .default(4)
      .describe("How many candidate rationales to draft"),
  }),
  output: z.object({
    rationales: z
      .array(z.string().min(1).max(1000))
      .min(1)
      .max(6)
      .describe("Candidate rationales, most fitting first"),
  }),
});

export type AgentMemoryPromotionRationalesInput = z.output<
  typeof agentMemoryPromotionRationales.input
>;
export type AgentMemoryPromotionRationalesOutput = z.output<
  typeof agentMemoryPromotionRationales.output
>;
