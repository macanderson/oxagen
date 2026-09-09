import { z } from "zod";
import { registerCapability } from "../registry";

/** An agent→environment binding as returned by every agent.environment.* read/write. */
export const agentEnvironmentBindingSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  environmentId: z.string(),
  environmentName: z.string(),
  environmentSlug: z.string(),
  isPrimary: z.boolean(),
});

export const agentEnvironmentBind = registerCapability({
  name: "bind_agent_environment",
  domain: "agent",
  description:
    "Bind an agent identity to an environment (a named vault of secrets it may resolve). Upserts the binding; promoting one to primary atomically demotes the agent's previous primary.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: {
    requiresApproval: false,
    riskLevel: "medium",
    category: "configuration",
  },
  layers: ["api", "mcp", "unit", "docs", "app"],
  scoped: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({
    agentId: z.string().min(1),
    environmentId: z.string().min(1),
    isPrimary: z.boolean().optional(),
  }),
  output: z.object({ binding: agentEnvironmentBindingSchema }),
});

export type AgentEnvironmentBindInput = z.output<
  typeof agentEnvironmentBind.input
>;
export type AgentEnvironmentBindOutput = z.output<
  typeof agentEnvironmentBind.output
>;
