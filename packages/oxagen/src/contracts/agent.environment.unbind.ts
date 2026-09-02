import { z } from "zod";
import { registerCapability } from "../registry";

export const agentEnvironmentUnbind = registerCapability({
  name: "unbind_agent_environment",
  domain: "agent",
  description:
    "Remove an agent's binding to an environment. When the removed binding was primary, resolution falls back to the workspace default environment and its default template.",
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
  }),
  output: z.object({ ok: z.boolean() }),
});

export type AgentEnvironmentUnbindInput = z.output<
  typeof agentEnvironmentUnbind.input
>;
