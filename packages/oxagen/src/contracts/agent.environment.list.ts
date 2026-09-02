import { z } from "zod";
import { registerCapability } from "../registry";
import { agentEnvironmentBindingSchema } from "./agent.environment.bind";

export const agentEnvironmentList = registerCapability({
  name: "list_agent_environments",
  domain: "agent",
  description:
    "List an agent's environment bindings, with each binding's resolved template name.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  layers: ["api", "mcp", "unit", "docs", "app"],
  scoped: true,
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({ bindings: z.array(agentEnvironmentBindingSchema) }),
});

export type AgentEnvironmentListOutput = z.output<
  typeof agentEnvironmentList.output
>;
