import { z } from "zod";
import { registerCapability } from "../registry";

// Trigger configuration (full replacement). Mirrors the shape accepted by
// automation.create.triggerConfig — event/schedule/api fields.
const triggerConfig = z.object({
  entityType: z.string().optional(),
  eventType: z.enum(["node.created", "node.updated", "node.deleted"]).optional(),
  propertyConditions: z
    .array(
      z.object({
        property: z.string(),
        fromValue: z.unknown().optional(),
        toValue: z.unknown().optional(),
        operator: z.enum(["eq", "gt", "lt", "changed"]).default("eq"),
      }),
    )
    .optional(),
  cronExpression: z.string().optional(),
  timezone: z.string().optional(),
});

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
    name: z.string().min(1).max(120).optional().describe("New name (omit to keep)"),
    description: z
      .string()
      .max(500)
      .nullable()
      .optional()
      .describe("New description; null clears it, omit to keep"),
    triggerConfig: triggerConfig
      .optional()
      .describe("Full replacement of the trigger configuration; omit to keep the existing config"),
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
