import { z } from "zod";
import { registerCapability } from "../registry";

// Disabling is always safe (turning an automation OFF can never cause an
// autonomous side effect), so unlike automation.enable it needs no approval.
export const automationDisable = registerCapability({
  name: "disable_automation",
  domain: "automation",
  description:
    "Disable an automation trigger so it stops firing. Safe to call without confirmation. Returns the new enabled state.",
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
      .describe(
        "Trigger public ID returned by automation.create / automation.list",
      ),
  }),
  output: z.object({
    automation_id: z.string(),
    enabled: z.boolean(),
    status: z.string().describe("'paused' once disabled"),
  }),
});

export type AutomationDisableInput = z.output<typeof automationDisable.input>;
export type AutomationDisableOutput = z.output<typeof automationDisable.output>;
