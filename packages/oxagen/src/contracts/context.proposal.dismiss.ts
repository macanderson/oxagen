// dismiss_proposal — reject a proposal with a reason (ADR-061; App. E). A
// proposal with an open Context PR has the PR closed and its branch deleted.
// The handler gates on the caller's org or workspace role, which only a
// signed-in user holds; an API key carries no user, so the MCP surface
// (API-key auth) is not declared.
import { z } from "zod";
import { registerCapability } from "../registry";

export const contextProposalDismiss = registerCapability({
  name: "dismiss_proposal",
  domain: "context",
  description:
    "Reject a record proposal with a reason. Refused once the proposal has merged.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: {
    requiresApproval: false,
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
      reason: z.string().min(1).max(2000),
    })
    .strict(),
  output: z
    .object({
      proposalId: z.string(),
      status: z.literal("rejected"),
    })
    .strict(),
});

export type ContextProposalDismissInput = z.output<
  typeof contextProposalDismiss.input
>;
export type ContextProposalDismissOutput = z.output<
  typeof contextProposalDismiss.output
>;
