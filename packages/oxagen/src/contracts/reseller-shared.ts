// reseller-shared.ts — shared zod schemas for the reseller-revenue capability
// family ("Stripe for agents": per-end-customer usage attribution → priced
// re-bill push). Every reseller.* contract imports its object shapes from here
// so the API route, MCP tools, handlers, and app UI all agree on one wire shape.
//
// Identity rule: every id crossing the wire is a public_id (e.g. `rescus_…`),
// never a raw UUID — the app cites customers/plans by name, and the raw id lives
// only behind an inspectable citation. See CLAUDE.md "Citing nodes & edges".

import { z } from "zod";

/** A reseller customer account is either actively billed or paused (excluded from pushes). */
export const resellerCustomerStatusSchema = z.enum(["active", "paused"]);
export type ResellerCustomerStatus = z.output<
  typeof resellerCustomerStatusSchema
>;

/**
 * How a price plan turns raw metered cost into what the customer is billed:
 * - `markup`   — bill raw cost × (1 + markup_bps/10000). Basis points so a 20%
 *                markup is 2000; keeps the reseller's margin proportional to spend.
 * - `per_unit` — bill unit_price_cents × attributed units (metered executions),
 *                ignoring raw cost. A flat menu price per agent action.
 */
export const resellerPricingModeSchema = z.enum(["markup", "per_unit"]);
export type ResellerPricingMode = z.output<typeof resellerPricingModeSchema>;

/**
 * The observed-usage dimension an attribution rule keys on. Each maps a slice of
 * the org's metered usage to one customer:
 * - `workspace`  — match_value is a workspace public id / uuid.
 * - `principal`  — match_value is an acting-principal uuid (who ran it).
 * - `capability` — match_value is a capability name (what ran).
 */
export const resellerMatchKindSchema = z.enum([
  "workspace",
  "principal",
  "capability",
]);
export type ResellerMatchKind = z.output<typeof resellerMatchKindSchema>;

/** Lifecycle of a single per-customer re-bill push. */
export const resellerRebillStatusSchema = z.enum([
  "pending",
  "pushed",
  "failed",
]);
export type ResellerRebillStatus = z.output<typeof resellerRebillStatusSchema>;

/** A reseller customer account as returned by every reseller_customer.* read/write. */
export const resellerCustomerSchema = z.object({
  /** public id, `rescus_…`. */
  id: z.string(),
  name: z.string(),
  /** The reseller's own external identifier for this customer (CRM id, etc.). */
  externalRef: z.string().nullable(),
  /** Cached customer id in the reseller's Stripe account, once a push has created one. */
  stripeCustomerId: z.string().nullable(),
  /** public id of the assigned price plan, or null (unpriced customers can't be pushed). */
  pricePlanId: z.string().nullable(),
  /** Resolved plan name for display — never make the UI look up the id. */
  pricePlanName: z.string().nullable(),
  status: resellerCustomerStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ResellerCustomer = z.output<typeof resellerCustomerSchema>;

/** A reseller price plan as returned by every reseller_price_plan.* read/write. */
export const resellerPricePlanSchema = z.object({
  /** public id, `resplan_…`. */
  id: z.string(),
  name: z.string(),
  pricingMode: resellerPricingModeSchema,
  /** Basis points of markup over raw cost; set for `markup` mode, else null. */
  markupBps: z.number().int().nullable(),
  /** Flat cents per metered unit; set for `per_unit` mode, else null. */
  unitPriceCents: z.number().int().nullable(),
  currency: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ResellerPricePlan = z.output<typeof resellerPricePlanSchema>;

/** An attribution rule as returned by every reseller_attribution_rule.* read/write. */
export const resellerAttributionRuleSchema = z.object({
  /** public id, `resrule_…`. */
  id: z.string(),
  matchKind: resellerMatchKindSchema,
  /** The raw identifier the rule matches (workspace/principal uuid, or capability name). */
  matchValue: z.string(),
  /** Human label captured when the rule was created, shown instead of the raw match_value. */
  matchLabel: z.string(),
  /** public id of the customer this slice of usage bills to. */
  customerId: z.string(),
  /** Resolved customer name for display. */
  customerName: z.string(),
  /** Evaluation order — lower runs first; the first matching rule wins a usage slice. */
  priority: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ResellerAttributionRule = z.output<
  typeof resellerAttributionRuleSchema
>;

/** One priced line of a re-bill (preview or pushed run). */
export const resellerRebillLineItemSchema = z.object({
  /** Human label for the attributed slice (workspace/principal/capability), never a raw uuid. */
  label: z.string(),
  /** Which dimension produced this line, or null for the aggregate/unattributed line. */
  matchKind: resellerMatchKindSchema.nullable(),
  /** Raw metered cost attributed to this slice, in cents. */
  rawCostCents: z.number().int().nonnegative(),
  /** Metered executions (units) attributed to this slice. */
  quantity: z.number().int().nonnegative(),
  /** Unit price applied for `per_unit` plans, else null. */
  unitPriceCents: z.number().int().nullable(),
  /** Final billed amount for this line after the plan is applied, in cents. */
  amountCents: z.number().int().nonnegative(),
});
export type ResellerRebillLineItem = z.output<
  typeof resellerRebillLineItemSchema
>;

/** A per-customer re-bill preview: what the next invoice would look like before pushing. */
export const resellerRebillPreviewSchema = z.object({
  customerId: z.string(),
  customerName: z.string(),
  pricePlanId: z.string().nullable(),
  pricePlanName: z.string().nullable(),
  currency: z.string(),
  /** Sum of rawCostCents across lines — the reseller's own metered cost. */
  subtotalCents: z.number().int().nonnegative(),
  /** Sum of amountCents across lines — what the customer would be billed. */
  totalCents: z.number().int().nonnegative(),
  lineItems: z.array(resellerRebillLineItemSchema),
});
export type ResellerRebillPreview = z.output<
  typeof resellerRebillPreviewSchema
>;

/** A historical (or in-flight) re-bill run as returned by reseller_rebill.list_runs / push. */
export const resellerRebillRunSchema = z.object({
  /** public id, `resrun_…`. */
  id: z.string(),
  customerId: z.string(),
  customerName: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  currency: z.string(),
  subtotalCents: z.number().int().nonnegative(),
  totalCents: z.number().int().nonnegative(),
  /** Reseller-account invoice id (`in_…`), once pushed. */
  providerInvoiceId: z.string().nullable(),
  /** Hosted invoice URL the reseller can send to their customer. */
  hostedInvoiceUrl: z.string().nullable(),
  status: resellerRebillStatusSchema,
  /** Failure reason for a `failed` push, shown inline in the UI. */
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ResellerRebillRun = z.output<typeof resellerRebillRunSchema>;

// ── Shared input field builders ──────────────────────────────────────────────
// Exported so xmcp tools can splice individual fields into their arg map (the
// contract `input` may be wrapped in `.refine()`, which strips `.shape`).

/** An ISO-8601 instant with offset — the re-bill period boundaries. */
export const isoInstant = z.string().datetime({ offset: true });
