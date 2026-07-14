import { z } from "zod";
import { registerCapability } from "../registry";
import { triggerConfigSchema } from "../trigger-conditions";

// Trigger configuration (full replacement). Shared with automation.create via
// the single triggerConfigSchema — event/schedule/api fields incl. conditionTree.
const triggerConfig = triggerConfigSchema;

export const automationUpdate = registerCapability({
  name: "update_automation",
  domain: "automation",
  description:
    "Edit an existing automation: rename it, change its description, and/or replace its trigger configuration (conditions / schedule). Enable/disable is handled separately by automation.enable / automation.disable. Partial update — omit a field to leave it unchanged.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "automation" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    automation_id: z
      .string()
      .min(1)
      .describe("Trigger public ID (plt_*) of the automation to update"),
    name: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe("New name (omit to keep)"),
    description: z
      .string()
      .max(500)
      .nullable()
      .optional()
      .describe("New description; null clears it, omit to keep"),
    triggerConfig: triggerConfig
      .optional()
      .describe(
        "Full replacement of the trigger configuration; omit to keep the existing config",
      ),
  }),
  output: z.object({
    automation_id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    triggerType: z.string(),
    enabled: z.boolean(),
  }),
});

export type AutomationUpdateInput = z.output<typeof automationUpdate.input>;
export type AutomationUpdateOutput = z.output<typeof automationUpdate.output>;
