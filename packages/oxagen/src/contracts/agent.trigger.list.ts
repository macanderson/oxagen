import { z } from "zod";
import { registerCapability } from "../registry";

export const agentTriggerList = registerCapability({
  name: "list_triggers",
  domain: "agent",
  description:
    "List the (non-deleted) triggers configured for an agent in the current workspace",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "introspection" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    agentId: z.string().describe("Agent public id (agt_…) or UUID"),
  }),
  output: z.object({
    triggers: z.array(
      z.object({
        triggerId: z.string(),
        publicId: z.string(),
        triggerType: z.enum(["manual", "schedule", "event"]),
        eventSource: z.string().nullable(),
        eventType: z.string().nullable(),
        connectionId: z.string().nullable(),
        filter: z.record(z.string(), z.unknown()),
        schedule: z.string().nullable(),
        enabled: z.boolean(),
      }),
    ),
  }),
});

export type AgentTriggerListInput = z.output<typeof agentTriggerList.input>;
export type AgentTriggerListOutput = z.output<typeof agentTriggerList.output>;
