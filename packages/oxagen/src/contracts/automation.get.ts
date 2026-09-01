import { z } from "zod";
import { registerCapability } from "../registry";

export const automationGet = registerCapability({
  name: "get_automation",
  domain: "automation",
  description: "Get one automation's trigger config, description, steps, and recent run history",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"],
  layers: ["schema", "api", "mcp", "docs", "unit", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    automation_id: z.string().min(1).describe("Trigger public ID (plt_*) from automation.list"),
  }),
  output: z.object({
    automation_id: z.string(),
    playbook_id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    triggerType: z.enum(["event", "schedule", "api"]),
    enabled: z.boolean(),
    triggerConfig: z.record(z.unknown()),
    steps: z.array(
      z.object({
        stepKey: z.string(),
        name: z.string(),
        stepType: z.string(),
        config: z.record(z.unknown()),
      }),
    ),
    runs: z.array(
      z.object({
        id: z.string(),
        status: z.string(),
        source: z.string(),
        startedAt: z.string().nullable(),
        completedAt: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
  }),
});

export type AutomationGetInput = z.output<typeof automationGet.input>;
export type AutomationGetOutput = z.output<typeof automationGet.output>;
