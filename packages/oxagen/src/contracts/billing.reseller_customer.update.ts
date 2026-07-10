import { z } from "zod";
import { registerCapability } from "../registry";
import {
  resellerCustomerSchema,
  resellerCustomerStatusSchema,
} from "./reseller-shared";

/**
 * update_reseller_customer — edit an account: rename, re-tag its external ref,
 * assign/clear a price plan, or pause it (paused customers are skipped by pushes).
 * Every field is optional; only the provided fields change.
 */
export const resellerCustomerUpdate = registerCapability({
  name: "update_reseller_customer",
  domain: "billing",
  description:
    "Update a reseller end-customer account (name, external ref, assigned price plan, or active/paused status). Org-scoped; only supplied fields change.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "low", category: "billing" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Billing: "allow" }, workspace: {} },
  input: z.object({
    /** public id of the customer to update. */
    id: z.string().min(1),
    name: z.string().min(1).max(200).optional(),
    externalRef: z.string().max(200).nullable().optional(),
    /** public id of a price plan, or null to clear. */
    pricePlanId: z.string().nullable().optional(),
    status: resellerCustomerStatusSchema.optional(),
  }),
  output: z.object({ customer: resellerCustomerSchema }),
});

export type ResellerCustomerUpdateInput = z.output<
  typeof resellerCustomerUpdate.input
>;
export type ResellerCustomerUpdateOutput = z.output<
  typeof resellerCustomerUpdate.output
>;
