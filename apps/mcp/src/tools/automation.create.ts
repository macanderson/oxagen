import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { automationCreate } from "@oxagen/oxagen/contracts/automation.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
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
  triggerConfig: z
    .object({
      entityType: z
        .string()
        .optional()
        .describe("Graph entity type to watch, e.g. 'Contact', 'Deal'"),
      eventType: z
        .enum(["node.created", "node.updated", "node.deleted"])
        .optional()
        .describe("Graph event type — required when triggerType='event'"),
      propertyConditions: z
        .array(
          z.object({
            property: z
              .string()
              .describe("Property name to evaluate, e.g. 'status', 'value'"),
            fromValue: z
              .unknown()
              .optional()
              .describe("Previous value the property must have had"),
            toValue: z
              .unknown()
              .optional()
              .describe("New value the property must now have"),
            operator: z
              .enum(["eq", "gt", "lt", "changed"])
              .default("eq")
              .describe(
                "Comparison operator: eq=exact match, changed=any change, gt/lt=numeric comparison",
              ),
          }),
        )
        .optional()
        .describe(
          "Property conditions to filter which node changes fire the trigger",
        ),
      cronExpression: z
        .string()
        .optional()
        .describe(
          "POSIX cron expression — required when triggerType='schedule', e.g. '0 9 * * 1' for Monday 9am",
        ),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone for schedule, e.g. 'America/New_York'. Default: UTC",
        ),
    })
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
};

export const metadata: ToolMetadata = {
  name: automationCreate.name,
  description: automationCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function automationCreateTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(automationCreate.name, args, ctx, { surface: "mcp" });
  return automationCreate.output.parse(output);
}
