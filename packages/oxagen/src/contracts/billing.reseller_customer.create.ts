import { z } from "zod";
import { registerCapability } from "../registry";
import { resellerCustomerSchema } from "./reseller-shared";

/**
 * create_reseller_customer — the end-customer accounts a reseller bills, distinct
 * from its own org membership. The first primitive of the "Stripe for agents"
 * loop: you cannot attribute usage or push a re-bill without a customer to bill.
 */
export const resellerCustomerCreate = registerCapability({
  name: "create_reseller_customer",
  domain: "billing",
  description:
    "Create a reseller end-customer account (the party a reseller invoices for observed agent usage). Org-scoped; optionally assign a price plan up front.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "low", category: "billing" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Billing: "allow" }, workspace: {} },
  input: z.object({
    name: z.string().min(1).max(200),
    externalRef: z.string().max(200).nullable().optional(),
    /** public id of a price plan to assign, or null/omit for unpriced. */
    pricePlanId: z.string().nullable().optional(),
  }),
  output: z.object({ customer: resellerCustomerSchema }),
});

export type ResellerCustomerCreateInput = z.output<
  typeof resellerCustomerCreate.input
>;
export type ResellerCustomerCreateOutput = z.output<
  typeof resellerCustomerCreate.output
>;
