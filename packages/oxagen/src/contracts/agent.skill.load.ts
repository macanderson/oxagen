import { z } from "zod";
import { registerCapability } from "../registry";

export const agentSkillLoad = registerCapability({
  name: "agent.skill.load",
  domain: "agent",
  description: "Load a skill into the agent's working context for the current turn",
  mode: "sync",
  surfaces: ["agent"],
  layers: ["schema", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "context" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    slug: z.string(),
    parentMessageId: z.string(),
  }),
  output: z.object({
    slug: z.string(),
    body: z.string(),
    references: z.array(z.object({ path: z.string(), body: z.string() })),
  }),
});

export type AgentSkillLoadInput = z.output<typeof agentSkillLoad.input>;
export type AgentSkillLoadOutput = z.output<typeof agentSkillLoad.output>;
