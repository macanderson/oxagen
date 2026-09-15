import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * get_contract_rate
 *
 * The customer's contracted governed-action terms (ADR-055 §3,
 * apps/app/ARCHITECTURE.md §3.9): the per-GAU rate, the block size, the
 * currency, the included GAUs per month, the effective dates and where the
 * figures come from — a negotiated `billing.contract_terms` row when one is
 * in force, otherwise the published figures on the `billing.plans` row of
 * the org's entitled subscription (or the Free plan). The handler reads them
 * through `resolveContractTerms` on every call; nothing copies the tier into
 * the org, so a plan change shows on the next read.
 *
 * Money is never a float: `ratePerGauMicros` is a decimal string of
 * micro-dollars (1 cent = 10,000 micros), the one figure on the billing page
 * that is money, and the block price is `ratePerGauMicros × blockSizeGau`
 * computed by the reader with integer arithmetic.
 *
 * `noBillingGate: true` (INV-27): reading your rate is never refused for
 * lack of GAUs. Roles are Owner, Admin and Billing, checked in the handler
 * with `assertOrgRole` (INV-29) because the kernel's IAM check allows every
 * capability for a non-enterprise org.
 */
export const billingContractRateGet = registerCapability({
  name: "get_contract_rate",
  domain: "billing",
  description:
    "The organisation's contracted governed-action terms: per-GAU rate in micro-dollars, block size, currency, included GAUs per month, effective dates, and whether they are the published tier's figures or a negotiated agreement's",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "billing",
  },
  sensitivity: "low",
  mutates: false,
  noBillingGate: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Billing: "allow" },
    workspace: {},
  },
  input: z.object({}),
  output: z.object({
    source: z.enum(["published_tier", "negotiated"]),
    /** The agreement the negotiated row cites; null for a published tier. */
    agreementRef: z.string().nullable(),
    tier: z.enum(["free", "build", "scale", "enterprise"]),
    /** ISO 4217, lower case, as billing.plans.currency stores it. */
    currency: z.string().min(3).max(3),
    /** Micro-dollars per GAU as a decimal string; never a float. */
    ratePerGauMicros: z.string().regex(/^\d+$/),
    blockSizeGau: z.number().int().positive(),
    includedGauPerMonth: z.number().int().nonnegative(),
    /** ISO 8601 instant. */
    effectiveFrom: z.string().datetime(),
    /** ISO 8601 instant, or null while the terms are open-ended. */
    effectiveTo: z.string().datetime().nullable(),
  }),
});

export type BillingContractRateGetInput = z.output<
  typeof billingContractRateGet.input
>;
export type BillingContractRateGetOutput = z.output<
  typeof billingContractRateGet.output
>;
