import { z } from "zod";
import { registerCapability } from "../registry.js";

export const agentApprovalResolve = registerCapability({
  name: "agent.approval.resolve",
  domain: "agent",
  description: "Approve or deny a pending tool-call approval request; resolution resumes the paused agent stream",
  mode: "sync",
  surfaces: ["api", "agent"],
  layers: ["schema", "api", "unit", "e2e", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "approval" },
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

export type AgentApprovalResolveInput = z.infer<typeof agentApprovalResolve.input>;
export type AgentApprovalResolveOutput = z.infer<typeof agentApprovalResolve.output>;
