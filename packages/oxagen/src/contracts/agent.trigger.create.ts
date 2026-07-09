import { z } from "zod";
import { registerCapability } from "../registry";
import { agentTriggerSchema } from "../agent-schema";

export const agentTriggerCreate = registerCapability({
  name: "create_trigger",
  domain: "agent",
  description:
    "Create a trigger for an agent — a manual, scheduled (cron), or event binding validated against agentTriggerSchema and persisted as an agent_triggers row",
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
    trigger: agentTriggerSchema,
  }),
  output: z.object({
    triggerId: z.string(),
    publicId: z.string(),
    triggerType: z.enum(["manual", "schedule", "event"]),
    enabled: z.boolean(),
  }),
});

export type AgentTriggerCreateInput = z.output<typeof agentTriggerCreate.input>;
export type AgentTriggerCreateOutput = z.output<
  typeof agentTriggerCreate.output
>;
