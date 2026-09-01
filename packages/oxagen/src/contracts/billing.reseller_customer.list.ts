import { z } from "zod";
import { registerCapability } from "../registry";
import {
  resellerCustomerSchema,
  resellerCustomerStatusSchema,
} from "./reseller-shared";

/**
 * list_reseller_customers — the customer accounts table. Returns account rows
 * only (name, external ref, assigned plan, status); current-period usage and
 * projected revenue are computed by preview_reseller_rebill, keeping this read
 * cheap and free of a ClickHouse scan.
 */
export const resellerCustomerList = registerCapability({
  name: "list_reseller_customers",
  domain: "billing",
  description:
    "List the org's reseller end-customer accounts, optionally filtered by status. Account metadata only — call preview_reseller_rebill for usage and projected revenue.",
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
  input: z.object({ status: resellerCustomerStatusSchema.optional() }),
  output: z.object({ customers: z.array(resellerCustomerSchema) }),
});

export type ResellerCustomerListInput = z.output<
  typeof resellerCustomerList.input
>;
export type ResellerCustomerListOutput = z.output<
  typeof resellerCustomerList.output
>;
