import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * purchase_gau_bucket
 *
 * Buy governed action units in block quantities at the organisation's
 * contracted rate (ADR-055 §6, apps/app/ARCHITECTURE.md §3.9 item 11): the
 * handler prices `quantityGau / blockSizeGau` blocks from
 * `resolveContractTerms` at submit time and opens a Stripe Checkout Session
 * for them. The units land on the month's bucket when the session's
 * `checkout.session.completed` webhook arrives; the handler inserts nothing
 * pending, and the session's metadata is the whole record of the sale.
 *
 * The Checkout also saves the card it collects for off-session use, so a
 * prepaid org's next exhaustion takes the auto top-up path. That is the rev1
 * card-saving path of the Free-tier rule (spec §4.2, ADR-055 §6): a Free org
 * with no saved card is offered this purchase, never refused it.
 *
 * `noBillingGate: true` (INV-27): buying more is never refused for lack of
 * GAUs. Roles are Owner and Billing, checked in the handler with
 * `assertOrgRole` (INV-29). No money crosses this contract: the page prints
 * the total from `get_contract_rate`, and Stripe shows the authoritative
 * figure.
 */

/**
 * An app-relative path for the Checkout return: one leading slash, no scheme,
 * no `//` or `/\` (a protocol-relative URL), no whitespace or control
 * characters. The handler prefixes `NEXT_PUBLIC_APP_URL`, so the return can
 * only ever be the app's own origin.
 */
const appRelativePath = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^\/(?![/\\])[^\s\x00-\x1f\x7f]*$/, "app-relative path required");

/** The most governed action units one purchase buys. */
export const PURCHASE_GAU_MAX = 1_000_000;

export const billingGauBucketPurchase = registerCapability({
  name: "purchase_gau_bucket",
  domain: "billing",
  description:
    "Buy governed action units in block quantities at the organisation's contracted rate through Stripe Checkout; returns the Checkout URL, the quantity, the block size and the number of blocks",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "billing" },
  sensitivity: "high",
  mutates: true,
  noBillingGate: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Billing: "allow" },
    workspace: {},
  },
  input: z.object({
    /** Units to buy; a whole number of blocks at the contracted block size. */
    quantityGau: z.number().int().positive().max(PURCHASE_GAU_MAX),
    /** Where Checkout returns on success, relative to the app origin. */
    successPath: appRelativePath,
    /** Where Checkout returns on cancel, relative to the app origin. */
    cancelPath: appRelativePath,
  }),
  output: z.object({
    /** The Stripe-hosted Checkout page to send the customer to. */
    checkoutUrl: z.string().url(),
    quantityGau: z.number().int().positive(),
    blockSizeGau: z.number().int().positive(),
    blocks: z.number().int().positive(),
  }),
});

export type BillingGauBucketPurchaseInput = z.output<
  typeof billingGauBucketPurchase.input
>;
export type BillingGauBucketPurchaseOutput = z.output<
  typeof billingGauBucketPurchase.output
>;
