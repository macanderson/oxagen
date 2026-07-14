import { z } from "zod";
import { registerCapability } from "../registry";
import { triggerConfigSchema } from "../trigger-conditions";

export const automationCreate = registerCapability({
  name: "create_automation",
  domain: "automation",
  description:
    "Create a playbook and trigger for an automation. Use triggerType='event' for graph node changes (e.g. Contact status changes, new Commit nodes), 'schedule' for cron-based runs, or 'api' for manually-triggered playbooks. The steps array scaffolds the initial action — leave it empty to create a blank playbook. Always populate triggerConfig fully based on what the user described. Automations created by an AI agent ALWAYS start disabled regardless of the `enabled` input — a human must explicitly enable them via automation.enable.",
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
    name: z
      .string()
      .min(1)
      .max(120)
      .describe("Human-readable name for this automation"),
    description: z
      .string()
      .max(500)
      .optional()
      .describe("What this automation does and when it fires"),
    triggerType: z
      .enum(["event", "schedule", "api"])
      .describe(
        "How this automation is triggered: 'event' = graph node change, 'schedule' = cron, 'api' = manual",
      ),
    triggerConfig: triggerConfigSchema
      .default({})
      .describe("Trigger-type-specific configuration"),
    steps: z
      .array(
        z.object({
          name: z.string().describe("Step name"),
          stepType: z
            .enum([
              "agent",
              "tool",
              "condition",
              "webhook",
              "prompt",
              "human_input",
            ])
            .describe("Type of action this step performs"),
          config: z
            .record(z.unknown())
            .default({})
            .describe(
              "Step-type-specific config, e.g. {agentSlug: 'qa-chat'} for agent steps",
            ),
        }),
      )
      .default([])
      .describe(
        "Initial steps to scaffold. Leave empty to create a blank playbook the user can configure later.",
      ),
    enabled: z
      .boolean()
      .default(false)
      .describe(
        "Whether the trigger starts enabled. Honored only for direct human-origin calls (API key, CLI); AI-originated calls (in-app agent, MCP) are forced to false — use automation.enable afterwards.",
      ),
  }),
  output: z.object({
    automation_id: z
      .string()
      .describe(
        "Trigger public ID — use this with automation.trigger to fire it manually",
      ),
    playbook_id: z.string().describe("Playbook public ID"),
    name: z.string(),
    status: z.string(),
    triggerType: z.string(),
    enabled: z
      .boolean()
      .describe(
        "Whether the trigger is live. False when created by an AI agent — call automation.enable (human-gated) to activate.",
      ),
  }),
});

export type AutomationCreateInput = z.output<typeof automationCreate.input>;
export type AutomationCreateOutput = z.output<typeof automationCreate.output>;
