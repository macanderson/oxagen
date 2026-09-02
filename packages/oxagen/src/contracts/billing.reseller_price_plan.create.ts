import { z } from "zod";
import { registerCapability } from "../registry";
import {
  resellerPricePlanSchema,
  resellerPricingModeSchema,
} from "./reseller-shared";

/**
 * create_reseller_price_plan — the margin layer. A plan turns raw metered cost
 * into billed revenue either as a markup over cost (`markup`, basis points) or a
 * flat price per metered unit (`per_unit`, cents). Assigned to customers so a
 * re-bill can price their attributed usage.
 *
 * The mode/field cross-check lives in the contract so every surface (API, MCP,
 * app) rejects a plan that names a mode without its required rate.
 */
// Exported so the xmcp tool can build its arg map — the contract `input` wraps
// these in `.refine()` (a ZodEffects), which has no `.shape` to spread.
export const resellerPricePlanCreateFields = {
  name: z.string().min(1).max(200),
  pricingMode: resellerPricingModeSchema,
  /** Basis points of markup over raw cost (required for `markup`). 2000 = +20%. */
  markupBps: z.number().int().min(0).max(1_000_000).nullable().optional(),
  /** Flat cents per metered unit (required for `per_unit`). */
  unitPriceCents: z.number().int().min(0).nullable().optional(),
  currency: z.string().length(3).toLowerCase().default("usd"),
};

/**
 * Enforce that the chosen mode carries its own required rate: `markup` needs
 * `markupBps`, `per_unit` needs `unitPriceCents`. Supplying the *other* mode's
 * rate as well is not rejected here — the handler ignores it and stores null
 * for the unused column.
 */
function refinePricingMode<
  T extends {
    pricingMode: z.output<typeof resellerPricingModeSchema>;
    markupBps?: number | null;
    unitPriceCents?: number | null;
  },
>(v: T): boolean {
  if (v.pricingMode === "markup") return v.markupBps != null;
  return v.unitPriceCents != null;
}

export const resellerPricePlanCreate = registerCapability({
  name: "create_reseller_price_plan",
  domain: "billing",
  description:
    "Create a reseller price plan: a markup over raw metered cost (basis points) or a flat per-unit price (cents). Assign it to customers to price their re-bills.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "low", category: "billing" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Billing: "allow" }, workspace: {} },
  input: z.object(resellerPricePlanCreateFields).refine(refinePricingMode, {
    message:
      "markup plans require markupBps; per_unit plans require unitPriceCents",
    path: ["pricingMode"],
  }),
  output: z.object({ pricePlan: resellerPricePlanSchema }),
});

export type ResellerPricePlanCreateInput = z.output<
  typeof resellerPricePlanCreate.input
>;
export type ResellerPricePlanCreateOutput = z.output<
  typeof resellerPricePlanCreate.output
>;
