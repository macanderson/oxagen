import { z } from "zod";
import { registerCapability } from "../registry";

// Enabling an automation is the ONLY path from "configured" to "live".
// AI agents may create and edit automations freely, but activation must
// cross a human gate: requiresApproval renders an approval card in-app,
// MCP hosts surface their own tool-call confirmation, and CLI/API calls
// are human-initiated by construction. Never weaken this to auto-approve.
export const automationEnable = registerCapability({
  name: "enable_automation",
  domain: "automation",
  description:
    "Enable an automation trigger so it fires live. Requires explicit human confirmation — AI agents must never enable an automation without the user approving. Returns the new enabled state.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "automation" },
  sensitivity: "medium",
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
    status: z.string().describe("'active' once enabled"),
  }),
});

export type AutomationEnableInput = z.output<typeof automationEnable.input>;
export type AutomationEnableOutput = z.output<typeof automationEnable.output>;
