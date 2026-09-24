/**
 * provider.ts — Vendor-neutral BillingProvider interface.
 *
 * All billing business logic (customers, subscriptions, invoices, checkout,
 * grants, webhooks) depends on this interface, NOT on Stripe SDK types.
 * The concrete StripeProvider in stripe-provider.ts wraps the Stripe SDK and
 * translates between Stripe-specific and these neutral domain types.
 *
 * When a second provider is needed, implement BillingProvider and swap the
 * singleton in client.ts — nothing else changes.
 */

// ── Neutral domain types ─────────────────────────────────────────────────────

export interface BillingCustomerSearchResult {
  id: string;
}

export interface BillingCustomerCreateInput {
  name: string;
  metadata: Record<string, string>;
}

// ── Subscription domain types ────────────────────────────────────────────────

export type BillingInterval = "month" | "year";

export type BillingSubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "unpaid"
  | "paused";

export interface BillingSubscription {
  id: string;
  customerId: string;
  /** The metadata the provider received at subscription creation. */
  metadata: Record<string, string>;
  status: BillingSubscriptionStatus;
  billingInterval: BillingInterval;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  trialEnd: Date | null;
  /** Stripe product id of the first line item; null when none. */
  productId: string | null;
  /**
   * Provider price id of the first line item; null when none.
   *
   * An identity, not an amount: it says WHICH price this subscription is on,
   * never what it costs. A plan change compares money by previewing the
   * invoice (#3157); this is used only to recognise a subscription that is
   * already on the price being asked for.
   */
  priceId: string | null;
  seatCount: number;
}

export interface BillingSubscriptionUpdateInput {
  cancelAtPeriodEnd?: boolean;
}

/**
 * Proration strategy for a mid-cycle change.
 * - 'always_invoice': create prorations AND immediately invoice them — the
 *   customer is charged now (used for upgrades / seat increases).
 * - 'create_prorations': create prorations but DON'T invoice now — the credit
 *   or charge rolls onto the next cycle's invoice (used for seat decreases).
 * - 'none': no proration at all, change takes effect at the next cycle
 *   (used for plan downgrades that keep current access until renewal).
 */
export type BillingProrationBehavior =
  | "always_invoice"
  | "create_prorations"
  | "none";

export interface BillingSubscriptionUpgradeInput {
  /** New price id to switch to (provider-native id). */
  newPriceId: string;
  /** Proration behavior. Defaults to 'always_invoice'. */
  prorationBehavior?: BillingProrationBehavior;
  /** Stripe idempotency key — dedupes a retried mutating request. */
  idempotencyKey?: string;
  /**
   * The price the subscription was on when the proration decision was made.
   * When set, the swap refuses unless the subscription it is about to mutate
   * is still on it — see {@link SubscriptionMovedError}.
   *
   * Omitted when no preview was obtained. There is nothing to protect in that
   * case: an unpriceable change settles as `always_invoice`, which bills the
   * true difference whichever way it falls, and it is `none` that this guard
   * exists to keep honest.
   */
  expectedCurrentPriceId?: string;
  /**
   * The second the proration decision was priced at —
   * `BillingProrationPreview.prorationDate`, off the same preview that
   * produced `prorationBehavior` and the figure the customer approved.
   *
   * Sent as Stripe's `proration_date` so the invoice the swap raises is
   * computed from the same instant as the invoice that was previewed. Without
   * it Stripe re-anchors at whatever moment it processes the update, and the
   * unused credit for the old price has decayed in between — on an interval
   * change that means a bigger bill than the one just checked against the
   * approved maximum. It is also the anchor every attribution guard on the
   * preview is defined at, so a mutation landing elsewhere was subject to none
   * of them.
   *
   * Omitted when no preview was obtained. Manufacturing one here would be a
   * fresh reading wearing the preview's name, which is the confusion this
   * whole path exists to remove.
   */
  prorationDate?: number;
}

export interface BillingSubscriptionSeatUpdateInput {
  /** New seat/quantity count. Must be >= 1. */
  seats: number;
  /**
   * Proration behavior. Increases default to 'always_invoice' (charge now);
   * decreases should pass 'create_prorations' (credit next invoice).
   */
  prorationBehavior?: BillingProrationBehavior;
  /** Stripe idempotency key — dedupes a retried mutating request. */
  idempotencyKey?: string;
}

// ── Proration preview ─────────────────────────────────────────────────────────

export interface BillingProrationLine {
  description: string;
  amountCents: number;
  /** True when this line is a proration adjustment (vs a full-period charge). */
  proration: boolean;
}

/**
 * The result of simulating a subscription change WITHOUT applying it. Drives
 * the "you will be charged $X now" confirmation step before any money moves.
 */
/**
 * Raised when a previewed invoice carries proration lines but none of them
 * belong to the change being previewed.
 *
 * A preview anchors every proration it creates at the `proration_date` it was
 * asked for, so that timestamp is what tells this change's money apart from
 * money already pending on the account. If proration lines are present and
 * none carry that anchor, the preview cannot be attributed — and an
 * unattributable preview is not a preview of zero. Summing it anyway would
 * report the balance pending on the subscription as though it were the cost of
 * this change, which is the inversion this whole path exists to prevent
 * (#3157, PR #3171 review).
 *
 * Callers that decide a proration behaviour treat this like any other failed
 * preview: settle as `always_invoice`, which bills the true difference in
 * whichever direction it falls. Callers that quote a figure to a person
 * refuse to quote.
 */
export class ProrationAttributionError extends Error {
  readonly code = "PRORATION_ATTRIBUTION_FAILED" as const;
  constructor(
    readonly prorationDate: number,
    readonly unattributableLineCount: number,
  ) {
    super(
      `Previewed invoice carries ${unattributableLineCount} proration line(s), none anchored at proration_date ${prorationDate}; the cost of this change cannot be isolated.`,
    );
    this.name = "ProrationAttributionError";
  }
}

/**
 * Raised when this change's money cannot be told apart from money already
 * pending on the invoice, because something else already occupies the anchor.
 *
 * `proration_date` is Unix SECONDS and both preview paths derive it from
 * `Date.now()`, so a change committed in the same second as this preview
 * produces a proration whose `period.start` is identical to ours. Timestamp
 * equality is therefore not ownership, and at one-second granularity the
 * collision is structural rather than unlucky.
 *
 * Nothing in the payload settles it: `type` names the line's SOURCE, not the
 * request that produced it; `subscription_item` is the same item for both; and
 * `proration_details.credited_items` exists only on credit lines. So the
 * ambiguity is detected by OBSERVATION — a baseline preview of the invoice
 * without this change — rather than by guessing at a field, which would be one
 * more stand-in for a fact nobody recorded.
 *
 * Refusing is the recoverable direction. The next attempt gets a fresh anchor a
 * second later; a stranger's credit summed into an upgrade makes a real charge
 * read nonpositive, ships `none`, and is never raised at all (#3157, PR #3171
 * review).
 */
export class AmbiguousProrationAnchorError extends Error {
  readonly code = "PRORATION_ANCHOR_AMBIGUOUS" as const;
  constructor(
    readonly prorationDate: number,
    readonly pendingLineCount: number,
  ) {
    super(
      `The invoice already carries ${pendingLineCount} proration line(s) anchored at ${prorationDate}; this change's cost cannot be told apart from them.`,
    );
    this.name = "AmbiguousProrationAnchorError";
  }
}

/**
 * Raised when a previewed invoice has more lines than the bounded walk will
 * fetch, so the set the direction would be computed from is known-incomplete.
 *
 * The walk is bounded because the SDK forces the choice: `autoPagingToArray`
 * takes a required `limit`. What is not forced is what happens past it, and
 * answering from a set we already know is truncated is the one thing this path
 * never does — a partial sum is how an upgrade reads as a downgrade in the
 * first place.
 *
 * The bound is high enough that reaching it means something other than a
 * subscription this code can price: it bills ONE subscription item (every
 * preview reads `items.data[0]` and throws when there is none), so a legitimate
 * invoice here is one recurring line, at most two prorations for the change,
 * and pending items. Needing more than {@link MAX_PREVIEW_LINES} lines to
 * describe it is not a case this adapter understands, and spending more round
 * trips to discover that is worse than saying so (#3157, PR #3171 review).
 */
export class ProrationLinesTruncatedError extends Error {
  readonly code = "PRORATION_LINES_TRUNCATED" as const;
  constructor(readonly limit: number) {
    super(
      `The previewed invoice has at least ${limit} lines; this change's cost cannot be computed from a set known to be incomplete.`,
    );
    this.name = "ProrationLinesTruncatedError";
  }
}

/**
 * Raised when a previewed invoice does not carry the subscription it was
 * computed against, so the interval that decides whether this change resets
 * the billing-cycle anchor cannot be derived from the priced state.
 *
 * WHY THIS IS A REFUSAL AND NOT A FALLBACK.
 *
 * There is an obvious fallback: the adapter retrieved the subscription a
 * moment earlier to find the item to reprice, so it could label the preview
 * with that. It did, and that was the defect. A retrieval and a preview are
 * two provider requests with a window between them, and a plan update landing
 * in that window makes the label describe a subscription the invoice was not
 * priced against. Labelling is not deriving: passing the earlier snapshot
 * enforces that SOMETHING was supplied, never that it is the thing that was
 * priced (#3157, PR #3171 review, r4042380655).
 *
 * So there is no fallback to take. Either the preview says which subscription
 * it priced, or nobody knows and this refuses. The quote path already refuses
 * when a preview cannot be taken, for the same reason: quoting nothing is
 * recoverable, and quoting $0 for a charge that will not be $0 is the failure
 * this whole change exists to remove.
 */
export class PreviewedSubscriptionUnavailableError extends Error {
  readonly code = "PREVIEWED_SUBSCRIPTION_UNAVAILABLE" as const;
  constructor(readonly subscriptionId: string) {
    super(
      `The previewed invoice for ${subscriptionId} did not carry the subscription it was computed against, so the interval this change moves from cannot be established from the state that was priced.`,
    );
    this.name = "PreviewedSubscriptionUnavailableError";
  }
}

/**
 * Raised when a previewed invoice reports having been computed against a
 * subscription that is ALREADY on the price this change is moving to, while
 * the same invoice prices real money for making that move.
 *
 * WHAT THIS IS DEFENDING, AND WHY IT IS NOT PARANOIA.
 *
 * Deriving the interval from the preview rests on one unproven property: that
 * the `subscription` expanded onto the response is the STORED subscription as
 * that request saw it, not an object reflecting the `subscription_details`
 * overrides the preview was asked to simulate. Nothing in this repository can
 * confirm that — no Stripe script has been run against any account, sandbox
 * included — and a test double cannot falsify an assumption it was written
 * from.
 *
 * It does not fail gracefully. If the expansion were simulated,
 * {@link BillingProrationPreview.billingInterval} would be the interval being
 * moved TO, the caller would compare the target against itself, conclude
 * same-interval, select `none` and quote $0 — which is the exact defect this
 * whole change exists to remove, returning silently and looking correct.
 *
 * So the single source is asked to be self-consistent. A subscription really
 * on the target price cannot also be charged for moving to it: repricing an
 * item to the price it already holds moves no money, so the prorations
 * attributed to this change net to zero. Reporting the target price WHILE
 * pricing a real change is the signature of a simulated object, and it is read
 * off one response rather than by comparing two observations of the same
 * thing.
 *
 * WHY THE PRICE ALONE IS NOT ENOUGH TO REFUSE ON. `previewPlanChange` in the
 * domain has no already-applied guard — `changeOrgPlan` has one, this does not
 * — so a customer asking what their CURRENT plan would cost arrives here with
 * the target price equal to the price they are on. That is a legitimate
 * question with a legitimate answer of zero, and refusing on the price alone
 * would break it.
 *
 * WHAT IS LEFT. A simulated expansion whose real change happens to net exactly
 * zero across its proration lines would pass this. For a same-interval change
 * that is harmless — zero is also the true answer, and `none` is what either
 * reading selects. For an interval change it is not, and that residual is
 * stated rather than described as closed: it needs a live account to settle,
 * which is a maintainer action (#3157, PR #3171 review, r4042380655).
 */
export class SimulatedPreviewSubscriptionError extends Error {
  readonly code = "PREVIEWED_SUBSCRIPTION_SIMULATED" as const;
  constructor(
    readonly subscriptionId: string,
    readonly priceId: string,
    readonly prorationCents: number,
  ) {
    super(
      `The previewed invoice for ${subscriptionId} reports a subscription already on ${priceId}, the price this change moves to, yet prices ${prorationCents} cents of proration for making that move; the state it reports cannot be the state it priced.`,
    );
    this.name = "SimulatedPreviewSubscriptionError";
  }
}

/**
 * Raised when the subscription a swap is about to mutate is no longer on the
 * price the proration decision was made against.
 *
 * WHY A PRECONDITION AND NOT A CONDITIONAL UPDATE. Stripe has no
 * compare-and-set on `subscriptions.update`: the full parameter list carries
 * `items`, `proration_behavior`, `proration_date`, `billing_cycle_anchor` and
 * the rest, and nothing version-like, no ETag and no if-match. Checked at
 * source against `stripe@17.7.0`. So there is no primitive that makes the
 * mutation conditional on the state it was planned from, and the nearest
 * honest thing is a precondition read taken at the mutation site.
 *
 * It is deliberately taken at the MUTATION, not at the caller. The adapter
 * already retrieves the subscription immediately before updating it, to find
 * the item to reprice; asking the same retrieval whether the price still
 * matches costs nothing and puts the observation one round trip from the
 * write, rather than several round trips and a durable intent write away.
 *
 * WHAT IT COSTS WHEN MISSING. `planChangeDirection` selects `none` for a
 * change that does not raise the bill, and `none` writes no proration line at
 * all. Preview a $200 to $150 decrease and `none` is right; let a concurrent
 * update move the subscription to $100 first and the same call performs a real
 * $100 to $150 INCREASE carrying `none`, so the charge it owes is never raised
 * and nothing anywhere records that it was dropped (r4042477836).
 *
 * WHAT IS LEFT. A read and a write are not one operation, so a change landing
 * inside that last round trip is still invisible. The window is bounded by one
 * HTTP call with no intervening work, against the several calls and a database
 * write it replaces, and it is stated here rather than described as closed —
 * the same honesty `previewWithOwnedAnchor` applies to its own bracket.
 * Refusing is recoverable: the next attempt re-previews against the state that
 * actually exists.
 */
export class SubscriptionMovedError extends Error {
  readonly code = "SUBSCRIPTION_MOVED_SINCE_PREVIEW" as const;
  constructor(
    readonly subscriptionId: string,
    readonly expectedPriceId: string,
    readonly actualPriceId: string | null,
  ) {
    super(
      `Subscription ${subscriptionId} was priced on ${expectedPriceId} but is now on ${actualPriceId ?? "an unknown price"}; the proration decision was made for a change that is no longer the one being applied.`,
    );
    this.name = "SubscriptionMovedError";
  }
}

export interface BillingProrationPreview {
  /**
   * Net proration amount in cents for THIS change. Positive = the customer
   * will be charged now (seat increase / upgrade); negative = a credit applied
   * to their account / next invoice (seat decrease / downgrade); 0 = no change.
   */
  amountCents: number;
  /** True when amountCents > 0 (an immediate charge will occur). */
  isCharge: boolean;
  currency: string;
  /** Unix-seconds proration timestamp the preview was anchored to. */
  prorationDate: number;
  /**
   * Total of the previewed invoice, net of discounts — not just the proration
   * lines. When a change alters the recurring interval the provider resets the
   * billing-cycle anchor and invoices the new period immediately, and that
   * charge is a NON-proration line: `amountCents` cannot see it.
   *
   * What the invoice comes to, NOT what the customer will be asked for — see
   * {@link amountDueCents}. Reported and logged; never quoted.
   */
  totalCents: number;
  /**
   * What the provider will actually COLLECT for this invoice: the total, less
   * whatever credit the customer's account balance already covers.
   *
   * A customer carrying a balance — a refund, an overpayment, a credit note —
   * has `totalCents` and this disagree, and only this one is the answer to
   * "what happens to my card now". Quoting the total overstated the charge by
   * the whole balance; a balance larger than the invoice made it overstate a
   * collection of nothing (#3157, PR #3171 review).
   *
   * This is the same distinction {@link BillingInvoice.amountDueCents} already
   * draws for issued invoices. A preview is an invoice that has not been
   * issued, so it draws it the same way.
   */
  amountDueCents: number;
  /**
   * The recurring interval of the subscription THIS preview was computed
   * against, taken from the SAME PROVIDER REQUEST that priced it.
   *
   * It is here because the caller needs it and must not fetch it separately.
   * Whether a change resets the billing-cycle anchor is decided by comparing
   * the interval the subscription is on against the one being asked for, and a
   * caller that takes the first from its own `getSubscription` is comparing
   * against a subscription that is not the one this preview priced. A plan
   * update landing between the two reads makes them describe different
   * subscriptions: the caller sees monthly, the preview is computed on annual,
   * a move to monthly scores as same-interval, its negative proration reads as
   * a downgrade, `none` is selected and the quote is $0 — while the provider
   * resets the anchor and invoices the whole new month anyway.
   *
   * WHAT "THE SAME REQUEST" HAD TO MEAN, ON THE SECOND ATTEMPT.
   *
   * The first fix moved the field here and filled it from the subscription the
   * adapter had retrieved in order to find the item to reprice. That closed
   * the gap between the DOMAIN's read and the preview, and left an identical
   * gap one layer down: `subscriptions.retrieve` and `invoices.createPreview`
   * are also two requests, so the retrieved object was a LABEL on the preview,
   * not a derivation from it. A dashboard update landing between them
   * reproduced the whole defect inside the adapter, and a required parameter
   * enforced only that something was passed (#3157, PR #3171 review,
   * r4042380655).
   *
   * It is now read off the preview response itself: the preview is requested
   * with the subscription expanded, so one HTTP request returns both the
   * invoice and the subscription that invoice was priced against. There is no
   * window, because there is no second request — and nothing to compare,
   * because there is only one observation. A preview that does not carry it
   * raises {@link PreviewedSubscriptionUnavailableError} rather than falling
   * back to a snapshot from another moment.
   */
  billingInterval: BillingInterval;
  /**
   * The price the subscription was on when this preview priced it, and the
   * product behind it — both off the same single observation the interval
   * comes from.
   *
   * They are here for the two things that happen AFTER a preview and used to
   * be decided from somewhere else:
   *
   *  - `billingPriceId` is the state the proration decision was made against.
   *    The mutation that follows is bound to it: Stripe offers no conditional
   *    update, so the swap refuses if the subscription it is about to change
   *    is no longer on the price that was priced. Without that, a concurrent
   *    update turns a previewed $200→$150 decrease into a real $100→$150
   *    increase still carrying `none`, and the charge is never raised
   *    (r4042477836).
   *  - `billingProductId` identifies the plan the customer is moving FROM, for
   *    sizing the prorated credit grant. That used to come from
   *    `subscriptions.plan_id`, which is written by the post-mutation sync and
   *    is stale in exactly the failure the already-applied guard exists for: a
   *    row still reading Build for a subscription the provider already moved
   *    to Scale makes a Scale→Enterprise move grant a Build→Enterprise delta
   *    (r4042477853). The product rather than the price, because a
   *    grandfathered subscriber sits on an immutable old price that no
   *    catalogue row carries, while the product is what
   *    `syncSubscriptionFromStripe` already maps to a plan.
   *
   * Null when the provider reports no price or product for the item.
   */
  billingPriceId: string | null;
  billingProductId: string | null;
  /** Per-line breakdown of the proration adjustments. */
  lines: BillingProrationLine[];
}

export interface BillingSeatPreviewInput {
  seats: number;
  prorationBehavior?: BillingProrationBehavior;
}

export interface BillingPlanPreviewInput {
  newPriceId: string;
  prorationBehavior?: BillingProrationBehavior;
}

// ── Setup intent / off-session charge ────────────────────────────────────────

export interface BillingSetupIntent {
  /** Client secret the browser passes to Stripe.js to collect a card. */
  clientSecret: string;
  setupIntentId: string;
}

export interface BillingOffSessionChargeInput {
  customerId: string;
  amountCents: number;
  /** Saved payment method to charge; omit to use the customer's default. */
  paymentMethodId?: string;
  description: string;
  metadata: Record<string, string>;
  idempotencyKey?: string;
}

export interface BillingOffSessionChargeResult {
  paymentIntentId: string;
  status: string;
  /** True when the PaymentIntent reached 'succeeded'. */
  succeeded: boolean;
}

// ── Refunded charge domain type ───────────────────────────────────────────────

/**
 * Neutral representation of a Stripe `charge.refunded` event payload.
 * Ops issues a refund in the Stripe dashboard → Stripe fires this event →
 * we clawback the corresponding credits.
 */
export interface BillingRefundedCharge {
  /** Stripe charge id (ch_xxx). */
  id: string;
  /** The PaymentIntent that produced this charge, if any. */
  paymentIntentId: string | null;
  /** Total amount already refunded on this charge, in cents. */
  amountRefundedCents: number;
  currency: string;
  /** Org id from charge metadata, if Stripe carried it. */
  orgId: string | null;
  /**
   * The charge's own metadata, which a Checkout Session copies onto its
   * PaymentIntent only when it was created with `payment_intent_data.metadata`.
   * `oxagen_kind` says what was sold, so the refund handler debits the ledger
   * the sale credited rather than whichever one it reaches first (ADR-085).
   */
  metadata: Record<string, string>;
}

// ── Dispute domain type ───────────────────────────────────────────────────────

export interface BillingDispute {
  id: string;
  /** Charge the dispute is against. */
  chargeId: string | null;
  paymentIntentId: string | null;
  amountCents: number;
  currency: string;
  reason: string | null;
  status: string;
  /** Org id resolved from the charge/customer metadata, if available. */
  orgId: string | null;
}

// ── Invoice domain types ─────────────────────────────────────────────────────

export type BillingInvoiceStatus =
  | "draft"
  | "open"
  | "paid"
  | "void"
  | "uncollectible";

export interface BillingInvoiceLineItem {
  description: string;
  quantity: number;
  unitAmountCents: number;
  totalCents: number;
  metric: string | null;
  metadata: Record<string, string>;
}

export interface BillingInvoice {
  id: string;
  /** Raw provider invoice id (e.g. `in_xxx`). */
  providerInvoiceId: string;
  number: string | null;
  status: BillingInvoiceStatus;
  amountDueCents: number;
  amountPaidCents: number;
  amountRemainingCents: number;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
  dueAt: Date | null;
  paidAt: Date | null;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
  /** Subscription provider id (e.g. `sub_xxx`), if attached. */
  subscriptionId: string | null;
  /** Org id from invoice metadata, if present. */
  orgId: string | null;
  /** Reason this invoice was created ("subscription_create", "subscription_cycle", etc.). */
  billingReason: string | null;
  /**
   * The governed-action settlement this invoice settles, from
   * `metadata.gau_settlement_id`; null for every other invoice. The webhook
   * routes `invoice.paid` and `invoice.payment_failed` on it (ADR-055 §6).
   */
  gauSettlementId: string | null;
  /**
   * The prepaid order this invoice bills, from `metadata.prepaid_order_id` on
   * an invoice whose `metadata.oxagen_kind` is `prepaid_order`; absent or
   * null for every other invoice. The webhook grants the order on
   * `invoice.paid` and mirrors `invoice.voided` / `marked_uncollectible` onto
   * it (prepaid-orders.ts).
   */
  prepaidOrder?: BillingPrepaidOrderRef | null;
  lineItems: BillingInvoiceLineItem[];
}

/**
 * What a prepaid-order invoice's metadata says about the grant it pays for.
 *
 * `assistantSpendCap` is the operator's instruction for the org's monthly
 * cap on platform-paid assistant tokens, applied in the transaction that
 * grants the order's credits: `unchanged` leaves the cap as it is, `set`
 * writes `capCents` (null removes the cap). Metadata key
 * `assistant_spend_cap_cents`: absent → unchanged, `none` → null, digits →
 * that many credit cents.
 */
export interface BillingPrepaidOrderRef {
  orderId: string;
  assistantSpendCap: AssistantSpendCapChange;
}

export type AssistantSpendCapChange =
  | { kind: "unchanged" }
  | { kind: "set"; capCents: number | null };

// ── Checkout domain types ────────────────────────────────────────────────────

export interface BillingCheckoutSubscriptionInput {
  customerId: string;
  priceId: string;
  /** Number of seats / licenses. Defaults to 1 when omitted. */
  seats?: number;
  /** Metadata that Stripe should carry on the resulting subscription. */
  subscriptionMetadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
}

export interface BillingCheckoutPaymentInput {
  customerId: string;
  priceId: string;
  quantity: number;
  /** Metadata on the session itself (e.g. org_id). */
  metadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
}

export interface BillingCheckoutDynamicCreditInput {
  /** Provider customer id. */
  customerId: string;
  /** Org id — stored in session and payment metadata. */
  orgId: string;
  /** Amount the customer actually pays, in USD cents (after discount). */
  priceCents: number;
  /** Face-value credits the customer receives, in USD cents. */
  grantCents: number;
  /** Discount percentage applied, e.g. 15 for 15% off. */
  discountPercent: number;
  successUrl: string;
  cancelUrl: string;
}

/**
 * A block purchase of governed action units (ADR-055 §6,
 * apps/app/ARCHITECTURE.md §3.9 item 11). One `price_data` line at the block
 * price, `quantity: blocks`; the session and its invoice carry the terms the
 * purchase was priced at, so the webhook grant needs nothing from the
 * handler. The card Checkout collects is saved for off-session use (the
 * recorder's auto top-up).
 */
export interface BillingCheckoutGauInput {
  customerId: string;
  orgId: string;
  /** Units purchased: `blocks × block size`. */
  quantityGau: number;
  blocks: number;
  /** Price of one block in minor units of `currency`; a whole number by the plans/contract_terms CHECK. */
  blockPriceCents: number;
  /** Micro-dollars per GAU, recorded on the session for the settlement row. */
  ratePerGauMicros: bigint;
  /** ISO 4217, lower case. */
  currency: string;
  successUrl: string;
  cancelUrl: string;
}

export interface BillingCheckoutResult {
  sessionId: string;
  url: string;
}

/** The card a completed Checkout Session collected and saved to the customer. */
export interface BillingCheckoutPaymentMethod {
  id: string;
  /** Provider payment-method type (`card`, `link`, …). */
  type: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

// ── Governed-action settlement invoices ──────────────────────────────────────

/** The `oxagen_kind` a settlement invoice carries (ARCHITECTURE.md §3.9 item 11). */
export type GauInvoiceKind =
  | "gau_auto_topup"
  | "gau_interim"
  | "gau_period_close";

/**
 * How Stripe collects a settlement invoice: from the org's default card, or
 * by emailing the hosted invoice when the org has saved none.
 */
export type GauInvoiceCollection =
  | { method: "charge_automatically"; defaultPaymentMethodId: string }
  | { method: "send_invoice"; daysUntilDue: number };

export interface BillingGauInvoiceInput {
  customerId: string;
  orgId: string;
  /** The settlement row's id: the invoice metadata the webhook routes on, and the prefix of every idempotency key. */
  settlementId: string;
  kind: GauInvoiceKind;
  quantityGau: number;
  /** Micro-dollars per GAU, charged exactly as the line's unit amount. */
  ratePerGauMicros: bigint;
  /** ISO 4217, lower case. */
  currency: string;
  description: string;
  /**
   * The bucket month the units were used in, half-open `[start, end)`. Set
   * as the line's service period, so the invoice says which month it bills.
   */
  period: { start: Date; end: Date };
  collection: GauInvoiceCollection;
}

/** A settlement's invoice, addressed by both ids so each request can be keyed on the settlement. */
export interface BillingGauInvoiceRef {
  settlementId: string;
  invoiceId: string;
}

export interface BillingGauInvoicePayment {
  /** `paid`: collected. `open`: finalized and unpaid; Stripe owns collection from here. */
  status: "paid" | "open";
  amountCents: number;
  hostedInvoiceUrl: string | null;
}

// ── Prepaid-order invoices ───────────────────────────────────────────────────

/** One line of a prepaid order's invoice. */
export interface BillingPrepaidInvoiceLine {
  /** Stable per order: the line's idempotency key suffix and `metadata.line`. */
  key: "licence" | "gau" | "credits";
  description: string;
  quantity: number;
  /** Minor units per unit as a decimal string (sub-cent rates allowed). */
  unitAmountDecimal: string;
  /** Service period, half-open `[start, end)`; null for a line with none. */
  period: { start: Date; end: Date } | null;
}

/**
 * A prepaid order's invoice (billing.prepaid_orders): emailed to the
 * customer's billing contact and paid by bank transfer or on the hosted page.
 */
export interface BillingPrepaidInvoiceInput {
  customerId: string;
  orgId: string;
  /** The order's id: invoice metadata, and the prefix of every idempotency key. */
  orderId: string;
  /** ISO 4217, lower case. */
  currency: string;
  daysUntilDue: number;
  lines: BillingPrepaidInvoiceLine[];
  /** Printed in the invoice header: "Agreement", "PO number". At most four. */
  customFields: { name: string; value: string }[];
  /** The memo printed above the lines; null for none. */
  memo: string | null;
  footer: string;
  /** Extra metadata the webhook reads back (the assistant cap instruction). */
  metadata: Record<string, string>;
}

/** The invoice a prepaid order is billed on, addressed by both ids. */
export interface BillingPrepaidInvoiceRef {
  orderId: string;
  invoiceId: string;
  /**
   * The order's own total in minor units. A draft whose subtotal differs is
   * never sent: something between the order and the provider changed a line.
   */
  expectedSubtotalCents: number;
}

export interface BillingPrepaidInvoiceState {
  /** `open`: sent and unpaid. `paid`: the provider settled it on finalize. */
  status: "open" | "paid";
  number: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
  amountDueCents: number;
  /**
   * The assistant cap instruction the invoice metadata carries: the one
   * record of it, read by the issue-time grant and the webhook grant alike.
   */
  assistantSpendCap: AssistantSpendCapChange;
}

/** What `deleteOrVoidDraftInvoice` found and did. `absent`: already void or deleted. */
export type BillingDraftInvoiceOutcome =
  | "deleted"
  | "voided"
  | "paid"
  | "absent";

// ── Credit-pack line items ───────────────────────────────────────────────────

export interface BillingCreditPackLineItem {
  /** Credits encoded in the product/price metadata. */
  creditsPerUnit: number;
  quantity: number;
}

// ── Payment method domain types ──────────────────────────────────────────────

export type BillingPaymentMethodEventKind = "attached" | "detached";

export interface BillingPaymentMethod {
  id: string;
  customerId: string;
  type: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

// ── Webhook domain types ─────────────────────────────────────────────────────

export type BillingWebhookEventType =
  | "subscription.created"
  | "subscription.updated"
  | "subscription.deleted"
  | "subscription.trial_will_end"
  | "invoice.created"
  | "invoice.paid"
  | "invoice.payment_failed"
  | "invoice.payment_action_required"
  | "invoice.finalized"
  | "invoice.voided"
  | "invoice.marked_uncollectible"
  | "checkout.session.completed"
  | "payment_method.attached"
  | "payment_method.detached"
  | "payment_method.updated"
  | "dispute.created"
  | "dispute.closed"
  | "charge.refunded"
  | "unknown";

export interface BillingWebhookEvent {
  /** Unique provider event id (used for idempotency). */
  providerEventId: string;
  /** Provider-native API version string (for audit). */
  apiVersion: string | null;
  type: BillingWebhookEventType;
  /** The raw event payload, safe to store as JSONB. */
  rawPayload: Record<string, unknown>;

  // Typed data unions — exactly one will be set based on `type`.
  subscriptionId?: string; // subscription.* events (incl. trial_will_end)
  invoice?: BillingInvoice; // invoice.* events
  checkoutSession?: BillingCheckoutSession; // checkout.session.completed
  paymentMethod?: BillingPaymentMethod; // payment_method.* events
  dispute?: BillingDispute; // dispute.* events
  refundedCharge?: BillingRefundedCharge; // charge.refunded events
}

export interface BillingCheckoutSession {
  id: string;
  mode: string;
  paymentStatus: string;
  /** Provider customer the session was created for; null for a guest session. */
  customerId: string | null;
  /** Metadata on the session (e.g. org_id). */
  metadata: Record<string, string>;
  /** Provider subscription id created from this session (if mode=subscription). */
  subscriptionId: string | null;
  /**
   * The invoice a payment-mode session issued, present only when the session
   * was created with `invoice_creation` enabled (the GAU block purchase).
   */
  invoiceId: string | null;
  /**
   * The PaymentIntent a payment-mode session charged. Recorded on the GAU
   * settlement at grant time: a later refund or dispute names the
   * PaymentIntent, and nothing else links either back to the purchase
   * (ADR-085).
   */
  paymentIntentId: string | null;
  /**
   * What the session charged, tax included, in cents. The GAU settlement
   * records it: a refund's amount includes refunded tax, so this is the
   * denominator a partial reversal must prorate against (ADR-085).
   */
  amountTotalCents: number | null;
}

// ── BillingProvider interface ────────────────────────────────────────────────

export interface BillingProvider {
  // ── Customer ────────────────────────────────────────────────────────────────

  /** Search for an existing customer by metadata. Returns null when none found. */
  findCustomerByOrgId(
    orgId: string,
  ): Promise<BillingCustomerSearchResult | null>;

  /**
   * Whether this account still holds the customer. False when the id is
   * missing or deleted (a stale id from a previous Stripe account after a
   * key rotation), true when it is live. Transient provider errors throw so
   * the caller can retry rather than mint a duplicate.
   */
  customerExists(customerId: string): Promise<boolean>;

  /** Create a new customer. Returns the provider customer id. */
  createCustomer(input: BillingCustomerCreateInput): Promise<string>;

  // ── Subscription ────────────────────────────────────────────────────────────

  /** Retrieve a subscription by provider id. */
  getSubscription(subscriptionId: string): Promise<BillingSubscription>;

  /** Update a subscription (e.g. toggle cancel_at_period_end). */
  updateSubscription(
    subscriptionId: string,
    input: BillingSubscriptionUpdateInput,
  ): Promise<void>;

  /** Cancel a subscription immediately (not at period end). */
  cancelSubscription(subscriptionId: string): Promise<void>;

  /** Swap the price on the first subscription line item. */
  upgradeSubscription(
    subscriptionId: string,
    input: BillingSubscriptionUpgradeInput,
  ): Promise<void>;

  /** Update the quantity (seat count) of the first subscription line item. */
  setSubscriptionSeats(
    subscriptionId: string,
    input: BillingSubscriptionSeatUpdateInput,
  ): Promise<void>;

  /**
   * Simulate a seat-count change and return the proration that WOULD be
   * invoiced, without applying it. Drives the confirm-before-charge step.
   */
  previewSeatChange(
    subscriptionId: string,
    input: BillingSeatPreviewInput,
  ): Promise<BillingProrationPreview>;

  /**
   * Simulate a plan (price) change and return the proration that WOULD be
   * invoiced, without applying it.
   */
  previewPlanChange(
    subscriptionId: string,
    input: BillingPlanPreviewInput,
  ): Promise<BillingProrationPreview>;

  // ── Payment methods ───────────────────────────────────────────────────────────

  /** List the customer's saved card payment methods. */
  listPaymentMethods(customerId: string): Promise<BillingPaymentMethod[]>;

  /** Return the customer's default invoice payment method id, or null. */
  getDefaultPaymentMethodId(customerId: string): Promise<string | null>;

  /** Set the customer's default invoice payment method. */
  setDefaultPaymentMethod(
    customerId: string,
    paymentMethodId: string,
  ): Promise<void>;

  /** Detach (remove) a saved payment method from the customer. */
  detachPaymentMethod(paymentMethodId: string): Promise<void>;

  /**
   * Create a SetupIntent so the browser (Stripe.js / Elements) can collect and
   * save a new card without the PAN ever touching our servers.
   */
  createSetupIntent(customerId: string): Promise<BillingSetupIntent>;

  /** Charge a saved card off-session (used by credit auto-reload). */
  chargeOffSession(
    input: BillingOffSessionChargeInput,
  ): Promise<BillingOffSessionChargeResult>;

  // ── Invoice ─────────────────────────────────────────────────────────────────

  /** Retrieve a full invoice including line items. */
  getInvoice(invoiceId: string): Promise<BillingInvoice>;

  /**
   * Create a settlement's invoice as a draft (`auto_advance: false`) with its
   * one line: `quantityGau` units at the per-GAU rate. Stripe never finalizes
   * or collects the draft on its own.
   */
  createGauInvoice(
    input: BillingGauInvoiceInput,
  ): Promise<{ invoiceId: string }>;

  /**
   * Do what is left of a settlement invoice by Stripe's own state: finalize a
   * draft (`auto_advance: true`), charge an open `charge_automatically`
   * invoice off-session. Answers `open` for every outcome that leaves a
   * finalized, unpaid invoice with Stripe; throws for anything else.
   */
  finalizeAndPayGauInvoice(
    ref: BillingGauInvoiceRef,
  ): Promise<BillingGauInvoicePayment>;

  /**
   * Remove a superseded settlement's invoice: delete a draft, void an open
   * invoice, leave a paid, void or deleted one alone.
   */
  deleteOrVoidDraftInvoice(
    ref: BillingGauInvoiceRef,
  ): Promise<{ outcome: BillingDraftInvoiceOutcome }>;

  /**
   * Create a prepaid order's invoice as a draft (`auto_advance: false`,
   * `collection_method: send_invoice`) with one item per line. Every request
   * is keyed on the order id, so a retry inside the provider's idempotency
   * window returns the same invoice and the same items.
   */
  createPrepaidInvoice(
    input: BillingPrepaidInvoiceInput,
  ): Promise<{ invoiceId: string }>;

  /**
   * Send a prepaid order's invoice: a draft is checked against the order's
   * subtotal, then finalized and emailed in one request; an invoice that is
   * already open or paid is only read. Throws for a void or uncollectible
   * invoice, and for a draft whose subtotal is not the order's.
   */
  sendPrepaidInvoice(
    ref: BillingPrepaidInvoiceRef,
  ): Promise<BillingPrepaidInvoiceState>;

  // ── Checkout ─────────────────────────────────────────────────────────────────

  /** Create a subscription checkout session. */
  createSubscriptionCheckout(
    input: BillingCheckoutSubscriptionInput,
  ): Promise<BillingCheckoutResult>;

  /** Create a one-time payment checkout session. */
  createPaymentCheckout(
    input: BillingCheckoutPaymentInput,
  ): Promise<BillingCheckoutResult>;

  /**
   * Create a dynamic (customer-defined dollar amount) credit checkout session.
   * Uses inline `price_data` so no pre-created Stripe Price is needed.
   * The customer pays `priceCents` but receives `grantCents` in credits (the
   * difference is the volume discount incentive).
   */
  createDynamicCreditCheckout(
    input: BillingCheckoutDynamicCreditInput,
  ): Promise<BillingCheckoutResult>;

  /** List the credit-pack line items from a completed checkout session. */
  getCheckoutSessionCreditPacks(
    sessionId: string,
  ): Promise<BillingCreditPackLineItem[]>;

  /**
   * Create the block-purchase checkout session of ADR-055 §6: `mode: "payment"`,
   * one inline `price_data` line, an invoice for the payment, and the card
   * saved for off-session use. No pre-created Price is involved.
   */
  createGauCheckout(
    input: BillingCheckoutGauInput,
  ): Promise<BillingCheckoutResult>;

  /**
   * The payment method a completed checkout session charged and saved, or
   * null when the session holds none (unpaid, or a method Checkout did not
   * attach).
   */
  getCheckoutPaymentMethod(
    sessionId: string,
  ): Promise<BillingCheckoutPaymentMethod | null>;
  /**
   * The metadata on a charge, fetched by id.
   *
   * A Stripe Dispute carries its own metadata, which Stripe never populates
   * from the charge and nothing here sets, so a dispute reaches us with no
   * organisation and no indication of what was bought. The charge has both.
   * This is the only way to resolve either for a dispute (ADR-085 §8, #3189).
   *
   * **An empty object means the charge definitively carries no metadata, or
   * definitively does not exist. It does not mean the read failed.** A
   * transient or correctable fault — a timeout, a rate limit, a revoked or
   * mis-scoped key — MUST reject, so the webhook retries.
   *
   * The distinction is load-bearing rather than stylistic, because callers
   * treat `{}` as an answer. `onDisputeCreated` reads it as "this charge
   * cannot say what it bought", completes, and `processStripeEvent` marks the
   * event processed for ever; a GAU dispute that arrived before its grant is
   * then never parked and the later grant hands out units the money has left.
   * An implementation that converts every fault to `{}` therefore loses
   * reversals during an outage, silently, with no failed webhook to show for
   * it. ADR-085 §9 classifies which Stripe errors are definitive and which
   * are not; a new provider owes the same classification rather than the
   * blanket catch.
   */
  getChargeMetadata(chargeId: string): Promise<Record<string, string>>;

  // ── Webhook ─────────────────────────────────────────────────────────────────

  /**
   * Verify the request signature and parse the raw body into a typed
   * BillingWebhookEvent. Throws when the signature is invalid.
   */
  parseWebhookEvent(rawBody: string, signature: string): BillingWebhookEvent;
}
