import { z } from "zod";
import { registerCapability } from "../registry";
import { resellerAttributionRuleSchema } from "./reseller-shared";

/** list_reseller_attribution_rules — the rule list, returned in evaluation order. */
export const resellerAttributionRuleList = registerCapability({
  name: "list_reseller_attribution_rules",
  domain: "billing",
  description:
    "List the org's usage-attribution rules in evaluation order (priority ascending), each resolved to its customer name.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Billing: "allow" },
    workspace: {},
  },
  input: z.object({ customerId: z.string().min(1).optional() }),
  output: z.object({ rules: z.array(resellerAttributionRuleSchema) }),
});

export type ResellerAttributionRuleListInput = z.output<
  typeof resellerAttributionRuleList.input
>;
export type ResellerAttributionRuleListOutput = z.output<
  typeof resellerAttributionRuleList.output
>;
