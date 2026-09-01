import { z } from "zod";
import { registerCapability } from "../registry";

export const automationList = registerCapability({
  name: "list_automations",
  domain: "automation",
  description: "List automations in a workspace",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"],
  layers: ["schema", "api", "docs", "mcp", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "automation" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    workspace_id: z.string().optional(),
  }),
  output: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      status: z.string(),
      triggerType: z.string().describe("The trigger type for this automation: 'event', 'schedule', or 'api'"),
      triggers: z.array(z.string()),
    }),
  ),
});

export type AutomationListInput = z.output<typeof automationList.input>;
export type AutomationListOutput = z.output<typeof automationList.output>;
