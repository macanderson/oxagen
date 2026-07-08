import { z } from "zod";
import { registerCapability } from "../registry";

export const agentTriggerDelete = registerCapability({
  name: "delete_trigger",
  domain: "agent",
  description:
    "Soft-delete an agent trigger — marks deletedAt so the binding stops firing while preserving the audit record",
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
    triggerId: z.string().describe("Trigger public id (atr_…) or UUID"),
  }),
  output: z.object({
    triggerId: z.string(),
    deleted: z.boolean(),
  }),
});

export type AgentTriggerDeleteInput = z.output<typeof agentTriggerDelete.input>;
export type AgentTriggerDeleteOutput = z.output<
  typeof agentTriggerDelete.output
>;
