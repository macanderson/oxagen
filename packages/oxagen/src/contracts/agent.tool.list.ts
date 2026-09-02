import { z } from "zod";
import { registerCapability } from "../registry";

export const agentToolList = registerCapability({
  name: "list_agent_tools",
  domain: "agent",
  description:
    "List the capabilities surfaced as agent tools for the active workspace, after allowlist and risk filtering",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    includeExternal: z.boolean().default(true),
  }),
  output: z.object({
    tools: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        domain: z.string(),
        category: z.string().nullable(),
        riskLevel: z.enum(["low", "medium", "high"]),
        requiresApproval: z.boolean(),
        external: z.boolean(),
      }),
    ),
  }),
});

export type AgentToolListInput = z.output<typeof agentToolList.input>;
export type AgentToolListOutput = z.output<typeof agentToolList.output>;
