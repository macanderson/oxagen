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
  lineItems: BillingInvoiceLineItem[];
}

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
   * This is the only way to resolve either for a dispute (ADR-085 §7, #3189).
   *
   * Returns an empty object when the charge cannot be read, so a provider
   * fault degrades to "unknown" rather than throwing out of a webhook.
   */
  getChargeMetadata(chargeId: string): Promise<Record<string, string>>;

  // ── Webhook ─────────────────────────────────────────────────────────────────

  /**
   * Verify the request signature and parse the raw body into a typed
   * BillingWebhookEvent. Throws when the signature is invalid.
   */
  parseWebhookEvent(rawBody: string, signature: string): BillingWebhookEvent;
}
