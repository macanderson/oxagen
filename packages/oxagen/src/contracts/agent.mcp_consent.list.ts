import { z } from "zod";
import { registerCapability } from "../registry";

export const agentMcpConsentList = registerCapability({
  name: "list_mcp_consents",
  domain: "agent",
  description:
    "List external MCP tool consent grants in the active workspace (which tools the agent may invoke without re-prompting)",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    // When true, return only the calling user's grants. Default false = all
    // workspace grants (the workspace policy view).
    mineOnly: z.boolean().optional(),
  }),
  output: z.object({
    consents: z.array(
      z.object({
        publicId: z.string(),
        userId: z.string(),
        mcpServerId: z.string(),
        toolName: z.string(),
        status: z.enum(["granted", "denied"]),
        grantedAt: z.string().nullable(),
        deniedAt: z.string().nullable(),
        expiresAt: z.string().nullable(),
      }),
    ),
  }),
});

export type AgentMcpConsentListInput = z.output<
  typeof agentMcpConsentList.input
>;
export type AgentMcpConsentListOutput = z.output<
  typeof agentMcpConsentList.output
>;
