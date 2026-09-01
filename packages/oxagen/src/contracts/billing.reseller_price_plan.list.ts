import { z } from "zod";
import { registerCapability } from "../registry";
import { resellerPricePlanSchema } from "./reseller-shared";

/** list_reseller_price_plans — the plans the reseller can assign to customers. */
export const resellerPricePlanList = registerCapability({
  name: "list_reseller_price_plans",
  domain: "billing",
  description: "List the org's reseller price plans (markup or per-unit).",
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
  input: z.object({}),
  output: z.object({ pricePlans: z.array(resellerPricePlanSchema) }),
});

export type ResellerPricePlanListInput = z.output<
  typeof resellerPricePlanList.input
>;
export type ResellerPricePlanListOutput = z.output<
  typeof resellerPricePlanList.output
>;
