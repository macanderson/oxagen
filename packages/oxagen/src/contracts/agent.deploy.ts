import { z } from "zod";
import { registerCapability } from "../registry";

export const agentDeploy = registerCapability({
  name: "deploy_agent",
  domain: "agent",
  description:
    "Set an agent's deployment posture. Activating requires a published active version (else a typed error); deactivating is always allowed and makes the agent's triggers dormant",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "medium", category: "mutation" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    agentId: z.string().describe("Agent public id (agt_…) or UUID"),
    deploymentStatus: z.enum(["inactive", "active"]),
  }),
  output: z.object({
    agentId: z.string(),
    deploymentStatus: z.enum(["inactive", "active"]),
  }),
});

export type AgentDeployInput = z.output<typeof agentDeploy.input>;
export type AgentDeployOutput = z.output<typeof agentDeploy.output>;
