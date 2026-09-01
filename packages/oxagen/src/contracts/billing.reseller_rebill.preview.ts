import { z } from "zod";
import { registerCapability } from "../registry";
import { isoInstant, resellerRebillPreviewSchema } from "./reseller-shared";

/**
 * preview_reseller_rebill — the "what will this customer's invoice look like"
 * step. For a bounded period it reads observed usage, attributes each disjoint
 * slice (workspace × principal × capability) to a customer via the attribution
 * rules, and prices it with the customer's plan — WITHOUT touching Stripe.
 *
 * Omit `customerId` to preview every active customer (powers the accounts table's
 * usage + projected-revenue columns); pass one to preview a single customer.
 *
 * Read-only and `noBillingGate`: previewing your own re-bill must never itself be
 * metered or gated on credit — it still flows through invoke() for observability.
 */

// One-year ceiling bounds the ClickHouse scan (matches billing.usage.breakdown).
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

// Exported so the xmcp tool can build its arg map — the contract `input` wraps
// these in `.refine()` (a ZodEffects), which has no `.shape` to spread.
export const resellerRebillPreviewFields = {
  start: isoInstant.describe(
    "ISO-8601 start of the billing period (inclusive)",
  ),
  end: isoInstant.describe("ISO-8601 end of the billing period (exclusive)"),
  /** public id to preview one customer; omit for all active customers. */
  customerId: z.string().min(1).optional(),
} as const;

export const resellerRebillPreview = registerCapability({
  name: "preview_reseller_rebill",
  domain: "billing",
  description:
    "Compute per-customer re-bill line items for a period: attribute observed usage to customers via attribution rules, then price each slice with the customer's plan. Does not push to Stripe.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "billing" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Billing: "allow" },
    workspace: {},
  },
  input: z
    .object(resellerRebillPreviewFields)
    .refine((v) => new Date(v.end).getTime() > new Date(v.start).getTime(), {
      message: "end must be after start",
      path: ["end"],
    })
    .refine(
      (v) =>
        new Date(v.end).getTime() - new Date(v.start).getTime() <= MAX_RANGE_MS,
      { message: "period must not exceed 366 days", path: ["end"] },
    ),
  output: z.object({
    range: z.object({ start: z.string(), end: z.string() }),
    previews: z.array(resellerRebillPreviewSchema),
    /** Raw cost, in cents, of usage matched by no rule (informational). */
    unattributedCostCents: z.number().int().nonnegative(),
  }),
});

export type ResellerRebillPreviewInput = z.output<
  typeof resellerRebillPreview.input
>;
export type ResellerRebillPreviewOutput = z.output<
  typeof resellerRebillPreview.output
>;
