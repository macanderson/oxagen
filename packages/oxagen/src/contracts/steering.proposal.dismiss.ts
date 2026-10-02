// dismiss_proposal — reject a proposal, with a reason when one is given
// (ADR-061; App. E). It is the one close: the steering PR page's Close
// without merging calls it, and there is no separate reject. A
// proposal with an open steering PR has the PR closed and its branch deleted.
// The handler gates on the caller's org or workspace role, which only a
// signed-in user holds; an API key carries no user, so the MCP surface
// (API-key auth) is not declared.
import { z } from "zod";
import { registerCapability } from "../registry";

export const steeringProposalDismiss = registerCapability({
  name: "dismiss_proposal",
  domain: "context",
  description:
    "Reject a record proposal, with an optional reason, closing its steering PR and deleting its branch. Refused once the proposal has merged.",
  mode: "sync",
  surfaces: ["api", "agent"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  // It closes the proposal's steering PR and deletes the branch, so Stella
  // asks a person first.
  agent: {
    requiresApproval: true,
    riskLevel: "medium",
    category: "governance",
  },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z
    .object({
      proposalId: z.string().regex(/^prp_[0-9A-Za-z]+$/),
      /** Why it was closed. Optional: a blank close records no reason. */
      reason: z.string().trim().min(1).max(2000).optional(),
    })
    .strict(),
  output: z
    .object({
      proposalId: z.string(),
      status: z.literal("rejected"),
    })
    .strict(),
});

export type SteeringProposalDismissInput = z.output<
  typeof steeringProposalDismiss.input
>;
export type SteeringProposalDismissOutput = z.output<
  typeof steeringProposalDismiss.output
>;
