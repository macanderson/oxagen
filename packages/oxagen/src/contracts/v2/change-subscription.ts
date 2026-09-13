import { z } from "zod";
import { defineTool } from "./_define";
import { billingSubscriptionUpgradeStart } from "../billing.subscription_upgrade.start";
// `purchase_credits` is absorbed but contributes no field — every one of its
// fields is in `drops` below, so there is nothing to import from it. The
// absorption is real: its Checkout-session mechanism is what `checkoutUrl` and
// the `checkout_required` status describe.

/**
 * Appendix E: `change_subscription` — absorbs `start_subscription_upgrade` and
 * `purchase_credits`.
 *
 * The mechanism carries and the product does not. Both sources do the same
 * thing: open a hosted Stripe Checkout session and hand back a URL, because
 * neither can complete the change itself — the subscription flips only when
 * Stripe's `customer.subscription.updated` webhook lands at apps/api. That
 * shape is the whole of what survives from `purchase_credits`.
 *
 * What does not survive is credits. §12.1: "There are no credits, no resellers,
 * and no revenue dashboard." A.10 deletes `billing.credit_*` along with
 * `billing.invoices` and `billing.payment_methods`, because Stripe holds
 * invoices and cards and Oxagen holds the meter. So every field that described
 * a credit pack — the face value bought, the credits granted, the discounted
 * price, the volume discount — is dropped, and the plan change is all that is
 * left. The prepayment discount §12.1 still offers is expressed by choosing the
 * annual `interval`, which carries.
 *
 * Cancellation is added because §12.1 promises it ("the customer can cancel any
 * time") and A.8 `billing.subscriptions.cancel_at` stores it, but v1 had no
 * contract for it at all — the only route was the Stripe portal. A tool called
 * `change_subscription` that can raise a plan and not lower it is a trap.
 */

export const changeSubscription = defineTool({
  name: "change_subscription",
  domain: "billing",
  description:
    "Change the organization's subscription: move to a different plan or billing interval, or schedule cancellation at the end of the current period. A plan change returns a hosted Stripe Checkout URL for the customer to complete — the subscription flips only when Stripe's webhook confirms it.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs", "app"],
  scoped: true,

  absorbs: ["start_subscription_upgrade", "purchase_credits"],
  drops: [
    {
      field: "amountUsd",
      from: "purchase_credits",
      why: "§12.1: 'There are no credits, no resellers, and no revenue dashboard.' A.10 removes billing.credit_* — there is no credit pack left to size",
    },
    {
      field: "grantCents",
      from: "purchase_credits",
      why: "credits are gone (§12.1); the meter that replaced the balance is runsThisPeriod against includedRuns on get_subscription (A.8)",
    },
    {
      field: "priceCents",
      from: "purchase_credits",
      why: "credits are gone; what the customer pays is the plan's price, which Stripe holds and Checkout shows",
    },
    {
      field: "percent",
      from: "purchase_credits",
      why: "the credit-pack volume discount. §12.1's discounts are the onboarding discount and annual prepayment, both expressed by the plan and `interval` rather than by a per-purchase percentage",
    },
    {
      field: "url",
      from: "purchase_credits",
      why: "the same Stripe Checkout URL as start_subscription_upgrade's `checkoutUrl`, carried under that name. Two names for one URL is how a client ends up handling both and testing neither",
    },
  ],

  /**
   * The two sources agree on every governance field — sensitivity high, risk
   * medium, approval required regardless of surface, and Owner or Billing only
   * — so there is nothing to reconcile. Approval stays required: this call ends
   * in a payment page, and §6.9's rule is that the money-moving step is the one
   * a human confirms.
   */
  agent: { requiresApproval: true, riskLevel: "medium", category: "billing" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    // Carried: Admin is deliberately absent. Changing what the org pays is the
    // Owner's or the Billing role's decision. Empty at workspace scope because
    // §14 puts Billing among the three organization-scope pages.
    org: { Owner: "allow", Billing: "allow" },
    workspace: {},
  },
  /**
   * New, and the same reasoning as get_subscription's: an org that has
   * exhausted its allowance must be able to buy its way out. Gating the upgrade
   * path on the balance the upgrade would fix locks the door from the inside.
   */
  noBillingGate: true,
  // Creates a Stripe Checkout session, or writes cancel_at. An external side
  // effect either way.
  mutates: true,

  input: z
    .object({
      /**
       * Carried, now optional: v1 had one verb (upgrade) so the plan was always
       * required. A cancellation names no new plan, and the refine below keeps
       * exactly one of the two intents present.
       */
      planSlug: billingSubscriptionUpgradeStart.input.shape.planSlug.optional(),
      /**
       * Carried. §12.1's annual prepayment discount is chosen here — it is what
       * is left of `purchase_credits`' volume discount, expressed as a term
       * rather than as a pack size.
       */
      interval: billingSubscriptionUpgradeStart.input.shape.interval.optional(),

      /**
       * New. §12.1: "the customer can cancel any time"; A.8 stores it as
       * `cancel_at`. Setting it false clears a scheduled cancellation, which is
       * why it is a boolean rather than a `cancel` verb.
       */
      cancelAtPeriodEnd: z.boolean().optional(),

      /**
       * Carried from start_subscription_upgrade, which required both; the
       * credit-purchase contract made them optional with a package-level
       * fallback. The stricter source wins — a Checkout session that returns
       * the customer to a default page rather than to the surface they started
       * from is a support ticket, and the fallback hid which surface that was.
       * Optional only because a cancellation opens no Checkout session.
       */
      successUrl:
        billingSubscriptionUpgradeStart.input.shape.successUrl.optional(),
      cancelUrl:
        billingSubscriptionUpgradeStart.input.shape.cancelUrl.optional(),
    })
    .refine((v) => v.planSlug != null || v.cancelAtPeriodEnd != null, {
      message:
        "provide planSlug (with interval) to change plan, or cancelAtPeriodEnd to schedule or clear a cancellation",
      path: ["planSlug"],
    })
    .refine((v) => v.planSlug == null || v.interval != null, {
      message: "interval is required when planSlug is given",
      path: ["interval"],
    })
    // A plan change ends at Stripe Checkout, and Checkout cannot start without
    // somewhere to return the customer to.
    .refine(
      (v) =>
        v.planSlug == null || (v.successUrl != null && v.cancelUrl != null),
      {
        message: "successUrl and cancelUrl are required for a plan change",
        path: ["successUrl"],
      },
    ),

  output: z.object({
    /**
     * Carried. Null for a cancellation: nothing is bought, so no Checkout
     * session exists. A caller that always opens this URL would otherwise open
     * "null".
     */
    checkoutUrl:
      billingSubscriptionUpgradeStart.output.shape.checkoutUrl.nullable(),
    /** Carried; null when the call only scheduled or cleared a cancellation. */
    planSlug: billingSubscriptionUpgradeStart.output.shape.planSlug.nullable(),
    interval: billingSubscriptionUpgradeStart.output.shape.interval.nullable(),

    /**
     * New, and the thing both sources left implicit in a comment: neither of
     * them completed anything. `checkout_required` means the change is not made
     * until the customer finishes at Stripe and the webhook lands;
     * `scheduled` means it is recorded and takes effect at the period end.
     */
    status: z.enum(["checkout_required", "scheduled"]),
    /** When a scheduled change takes effect (ISO 8601); null for a Checkout hand-off. */
    effectiveAt: z.string().datetime().nullable(),
  }),
});

export type ChangeSubscriptionInput = z.output<typeof changeSubscription.input>;
export type ChangeSubscriptionOutput = z.output<
  typeof changeSubscription.output
>;
