import { z } from "zod";
import { registerCapability } from "../registry";

export const agentMcpConsentResolve = registerCapability({
  name: "resolve_mcp_consent",
  domain: "agent",
  description:
    "Grant or deny first-use consent for an external MCP tool; the decision resumes the paused agent stream and is remembered for subsequent calls",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "approval" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    // The pending consent request id (the underlying approval row id) to resolve.
    approvalId: z.string(),
    decision: z.enum(["granted", "denied"]),
    // When true (and decision=granted), pre-grant every tool on the server
    // (tool_name='*') rather than only the prompted tool.
    grantAllTools: z.boolean().optional(),
  }),
  output: z.object({
    approvalId: z.string(),
    resolution: z.enum(["granted", "denied", "expired"]),
  }),
});

export type AgentMcpConsentResolveInput = z.output<
  typeof agentMcpConsentResolve.input
>;
export type AgentMcpConsentResolveOutput = z.output<
  typeof agentMcpConsentResolve.output
>;
