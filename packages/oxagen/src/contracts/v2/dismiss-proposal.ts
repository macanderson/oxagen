import { z } from "zod";
import { defineTool } from "./_define";
import { agentMemoryPromotionDismiss } from "../agent.memory_promotion.dismiss";

/**
 * Appendix E: `dismiss_proposal`. Absorbs `dismiss_memory_promotion`, with an
 * empty `Does` column — the behaviour is right as it stands.
 *
 * **The v1 semantics are the part worth preserving, and they are subtle.**
 * Dismissing silences the *suggestion*, not the record: v1's doc comment is
 * explicit that "the memory itself stays ACTIVE and recallable — only the
 * suggestion is silenced", and `restore: true` lets it re-qualify. That
 * asymmetry is why this is a separate tool from `retract_record`. An operator
 * saying "stop asking me about this" is not saying "this is wrong", and
 * collapsing the two would quietly delete knowledge every time someone cleared
 * a queue.
 *
 * **What changes is only that there is now something to dismiss.** v1 had to
 * stamp `promotion_dismissed_at` on the memory node because candidates were a
 * derived ranked window that would otherwise re-suggest the same memory on the
 * next load. §9 makes `record_proposal` a real record with a lifecycle, so
 * dismissal is a status on the proposal — which also means it survives the
 * proposal being re-ranked, and shows up in `list_proposals` with
 * `status: "dismissed"` instead of vanishing.
 */
export const dismissProposal = defineTool({
  name: "dismiss_proposal",
  domain: "context",
  description:
    "Dismiss a record proposal so it stops being suggested, or restore a dismissed one. The records behind it stay active and recallable — only the proposal is silenced.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,

  absorbs: ["dismiss_memory_promotion"],
  drops: [
    {
      field: "memoryId",
      from: "dismiss_memory_promotion",
      why: "v1 dismissed a memory because the candidate queue was derived from memories and had no rows of its own. §9's `record_proposal` is a record with an id and a lifecycle, so the dismissal names the proposal — which is also what stops the marker from following a memory that gets re-proposed for a better reason later",
    },
  ],

  // Carried unchanged: no approval, low risk. Nothing is lost by a dismissal,
  // which is exactly why it can be cheap.
  agent: { requiresApproval: false, riskLevel: "low", category: "memory" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  // Writes the proposal's status. Small, but a write.
  mutates: true,

  input: z.object({
    proposalId: z
      .string()
      .min(1)
      .describe("The record_proposal id to dismiss or restore"),

    /**
     * Carried by reference, default and describe intact. The restore path is
     * the reason dismissal is safe to offer freely — a queue cleared by mistake
     * is recoverable, so an operator can dismiss without deliberating.
     */
    restore: agentMemoryPromotionDismiss.input.shape.restore,
  }),

  output: z.object({
    proposalId: z.string(),

    /**
     * Carried by reference, including its describe. True means the proposal is
     * now excluded from suggestions; after a `restore` it is false, which is
     * the same field answering the same question in both directions.
     */
    dismissed: agentMemoryPromotionDismiss.output.shape.dismissed,
  }),
});

export type DismissProposalInput = z.output<typeof dismissProposal.input>;
export type DismissProposalOutput = z.output<typeof dismissProposal.output>;
