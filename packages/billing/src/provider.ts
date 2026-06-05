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
export type BillingProrationBehavior = "always_invoice" | "create_prorations" | "none";

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

// ── Setup intent / off-session charge / refund ────────────────────────────────

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

export interface BillingRefundInput {
  /** Charge or PaymentIntent id to refund. */
  paymentIntentId?: string;
  chargeId?: string;
  /** Partial refund amount; omit for a full refund. */
  amountCents?: number;
  reason?: "duplicate" | "fraudulent" | "requested_by_customer";
  idempotencyKey?: string;
}

export interface BillingRefundResult {
  refundId: string;
  amountCents: number;
  status: string;
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

export type BillingInvoiceStatus = "draft" | "open" | "paid" | "void" | "uncollectible";

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

export interface BillingCheckoutResult {
  sessionId: string;
  url: string;
}

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
  subscriptionId?: string;        // subscription.* events (incl. trial_will_end)
  invoice?: BillingInvoice;       // invoice.* events
  checkoutSession?: BillingCheckoutSession;  // checkout.session.completed
  paymentMethod?: BillingPaymentMethod;      // payment_method.* events
  dispute?: BillingDispute;       // dispute.* events
}

export interface BillingCheckoutSession {
  id: string;
  mode: string;
  paymentStatus: string;
  /** Metadata on the session (e.g. org_id). */
  metadata: Record<string, string>;
  /** Provider subscription id created from this session (if mode=subscription). */
  subscriptionId: string | null;
}

// ── BillingProvider interface ────────────────────────────────────────────────

export interface BillingProvider {
  // ── Customer ────────────────────────────────────────────────────────────────

  /** Search for an existing customer by metadata. Returns null when none found. */
  findCustomerByOrgId(orgId: string): Promise<BillingCustomerSearchResult | null>;

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
  setDefaultPaymentMethod(customerId: string, paymentMethodId: string): Promise<void>;

  /** Detach (remove) a saved payment method from the customer. */
  detachPaymentMethod(paymentMethodId: string): Promise<void>;

  /**
   * Create a SetupIntent so the browser (Stripe.js / Elements) can collect and
   * save a new card without the PAN ever touching our servers.
   */
  createSetupIntent(customerId: string): Promise<BillingSetupIntent>;

  /** Charge a saved card off-session (used by credit auto-reload). */
  chargeOffSession(input: BillingOffSessionChargeInput): Promise<BillingOffSessionChargeResult>;

  /** Issue a refund against a charge or PaymentIntent. */
  createRefund(input: BillingRefundInput): Promise<BillingRefundResult>;

  // ── Invoice ─────────────────────────────────────────────────────────────────

  /** Retrieve a full invoice including line items. */
  getInvoice(invoiceId: string): Promise<BillingInvoice>;

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

  // ── Webhook ─────────────────────────────────────────────────────────────────

  /**
   * Verify the request signature and parse the raw body into a typed
   * BillingWebhookEvent. Throws when the signature is invalid.
   */
  parseWebhookEvent(rawBody: string, signature: string): BillingWebhookEvent;
}
