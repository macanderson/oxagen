import { z } from "zod";
import { registerCapability } from "../registry";
import {
  resellerPricePlanSchema,
  resellerPricingModeSchema,
} from "./reseller-shared";

/**
 * update_reseller_price_plan — edit a plan's name, mode, or rate. When the mode
 * changes the caller must supply the new mode's rate; the handler validates the
 * resulting plan is internally consistent (markup→markupBps, per_unit→unitPriceCents).
 */
export const resellerPricePlanUpdate = registerCapability({
  name: "update_reseller_price_plan",
  domain: "billing",
  description:
    "Update a reseller price plan (name, mode, markup basis points, per-unit price, or currency). Only supplied fields change.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "low", category: "billing" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Billing: "allow" }, workspace: {} },
  input: z.object({
    /** public id of the plan to update. */
    id: z.string().min(1),
    name: z.string().min(1).max(200).optional(),
    pricingMode: resellerPricingModeSchema.optional(),
    markupBps: z.number().int().min(0).max(1_000_000).nullable().optional(),
    unitPriceCents: z.number().int().min(0).nullable().optional(),
    currency: z.string().length(3).toLowerCase().optional(),
  }),
  output: z.object({ pricePlan: resellerPricePlanSchema }),
});

export type ResellerPricePlanUpdateInput = z.output<
  typeof resellerPricePlanUpdate.input
>;
export type ResellerPricePlanUpdateOutput = z.output<
  typeof resellerPricePlanUpdate.output
>;
