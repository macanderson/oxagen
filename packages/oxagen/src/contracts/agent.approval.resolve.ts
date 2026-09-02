import { z } from "zod";
import { registerCapability } from "../registry";

export const agentApprovalResolve = registerCapability({
  name: "resolve_approval",
  domain: "agent",
  description:
    "Approve or deny a pending tool-call approval request; resolution resumes the paused agent stream",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "approval" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    approvalId: z.string(),
    decision: z.enum(["approved", "denied"]),
    note: z.string().optional(),
  }),
  output: z.object({
    approvalId: z.string(),
    resolution: z.enum(["approved", "denied", "expired"]),
  }),
});

export type AgentApprovalResolveInput = z.output<
  typeof agentApprovalResolve.input
>;
export type AgentApprovalResolveOutput = z.output<
  typeof agentApprovalResolve.output
>;
