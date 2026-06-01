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

export interface BillingSubscriptionUpgradeInput {
  /** New price id to switch to (provider-native id). */
  newPriceId: string;
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
  | "invoice.created"
  | "invoice.paid"
  | "invoice.payment_failed"
  | "checkout.session.completed"
  | "payment_method.attached"
  | "payment_method.detached"
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
  subscriptionId?: string;        // subscription.* events
  invoice?: BillingInvoice;       // invoice.* events
  checkoutSession?: BillingCheckoutSession;  // checkout.session.completed
  paymentMethod?: BillingPaymentMethod;      // payment_method.* events
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

  /** Swap the price on the first subscription line item, invoicing prorations immediately. */
  upgradeSubscription(
    subscriptionId: string,
    input: BillingSubscriptionUpgradeInput,
  ): Promise<void>;

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
