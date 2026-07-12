import { z } from "zod";
import { registerCapability } from "../registry";
import { agentTriggerSchema } from "../agent-schema";

export const agentTriggerUpdate = registerCapability({
  name: "update_trigger",
  domain: "agent",
  description:
    "Update an existing agent trigger in place — replaces its type-specific binding and enabled flag, re-validated against agentTriggerSchema",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "medium", category: "mutation" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    triggerId: z.string().describe("Trigger public id (atr_…) or UUID"),
    trigger: agentTriggerSchema,
  }),
  output: z.object({
    triggerId: z.string(),
    triggerType: z.enum(["manual", "schedule", "event"]),
    enabled: z.boolean(),
  }),
});

export type AgentTriggerUpdateInput = z.output<typeof agentTriggerUpdate.input>;
export type AgentTriggerUpdateOutput = z.output<
  typeof agentTriggerUpdate.output
>;
