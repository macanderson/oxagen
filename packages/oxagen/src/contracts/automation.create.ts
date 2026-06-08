import { z } from "zod";
import { registerCapability } from "../registry";

export const automationCreate = registerCapability({
  name: "automation.create",
  domain: "automation",
  description: "Create a new automation with a trigger and action",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "automation" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    name: z.string().min(1),
    trigger: z.string().optional(),
    action: z.string().optional(),
  }),
  output: z.object({
    automation_id: z.string(),
    name: z.string(),
    status: z.string(),
  }),
});

export type AutomationCreateInput = z.output<typeof automationCreate.input>;
export type AutomationCreateOutput = z.output<typeof automationCreate.output>;
