import { z } from "zod";
import { registerCapability } from "../registry";

/** delete_reseller_attribution_rule — remove a rule so its usage slice stops attributing. */
export const resellerAttributionRuleDelete = registerCapability({
  name: "delete_reseller_attribution_rule",
  domain: "billing",
  description:
    "Delete a reseller attribution rule. Usage it matched becomes unattributed until another rule covers it.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "low", category: "billing" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Billing: "allow" }, workspace: {} },
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ id: z.string(), deleted: z.literal(true) }),
});

export type ResellerAttributionRuleDeleteInput = z.output<
  typeof resellerAttributionRuleDelete.input
>;
export type ResellerAttributionRuleDeleteOutput = z.output<
  typeof resellerAttributionRuleDelete.output
>;
