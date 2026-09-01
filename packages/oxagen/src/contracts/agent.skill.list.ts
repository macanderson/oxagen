import { z } from "zod";
import { registerCapability } from "../registry";

export const agentSkillList = registerCapability({
  name: "list_agent_skills",
  domain: "agent",
  description: "List skills available in the active workspace — built-in filesystem skills plus tenant-defined skills",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "introspection" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    filter: z.string().optional(),
  }),
  output: z.object({
    skills: z.array(
      z.object({
        slug: z.string(),
        name: z.string(),
        description: z.string(),
        source: z.enum(["builtin", "tenant"]),
        version: z.string(),
      }),
    ),
  }),
});

export type AgentSkillListInput = z.output<typeof agentSkillList.input>;
export type AgentSkillListOutput = z.output<typeof agentSkillList.output>;
