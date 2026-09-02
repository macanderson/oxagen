import { z } from "zod";
import { registerCapability } from "../registry";

export const automationTrigger = registerCapability({
  name: "trigger_automation",
  domain: "automation",
  description: "Trigger an automation by ID with an optional payload",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"],
  layers: ["schema", "api", "docs", "mcp", "app"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "medium",
    category: "automation",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    automation_id: z.string(),
    payload: z.record(z.unknown()).optional(),
  }),
  output: z.object({
    execution_id: z.string(),
    status: z.string(),
  }),
});

export type AutomationTriggerInput = z.output<typeof automationTrigger.input>;
export type AutomationTriggerOutput = z.output<typeof automationTrigger.output>;
