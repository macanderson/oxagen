/**
 * stripe-provider.ts — Stripe SDK implementation of BillingProvider.
 *
 * This file is the ONLY place in the billing package that imports from the
 * `stripe` package. All other files use the BillingProvider interface from
 * provider.ts. Swap this file (or the singleton in client.ts) to replace the
 * vendor without touching business logic.
 */

import Stripe from "stripe";
import { requireEnv } from "@oxagen/config/env";
import { logger } from "./logger";
import type {
  BillingCreditPackLineItem,
  BillingCheckoutDynamicCreditInput,
  BillingCheckoutGauInput,
  BillingCheckoutPaymentInput,
  BillingCheckoutPaymentMethod,
  BillingCheckoutResult,
  BillingCheckoutSession,
  BillingCheckoutSubscriptionInput,
  BillingCustomerCreateInput,
  BillingCustomerSearchResult,
  BillingDispute,
  BillingDraftInvoiceOutcome,
  BillingGauInvoiceInput,
  BillingGauInvoicePayment,
  BillingGauInvoiceRef,
  BillingInvoice,
  BillingInvoiceLineItem,
  BillingOffSessionChargeInput,
  BillingOffSessionChargeResult,
  BillingPaymentMethod,
  BillingPlanPreviewInput,
  BillingProrationPreview,
  BillingProvider,
  BillingRefundedCharge,
  BillingSeatPreviewInput,
  BillingSetupIntent,
  BillingSubscription,
  BillingSubscriptionSeatUpdateInput,
  BillingSubscriptionStatus,
  BillingSubscriptionUpdateInput,
  BillingSubscriptionUpgradeInput,
  BillingWebhookEvent,
  BillingWebhookEventType,
} from "./provider";

/** Wrap an optional Stripe idempotency key into request options. */
function idempotency(
  key: string | undefined,
): Stripe.RequestOptions | undefined {
  return key ? { idempotencyKey: key } : undefined;
}

/** Whether automatic tax calculation (Stripe Tax) is enabled for this account. */
function automaticTaxEnabled(): boolean {
  // Gated by env so the code path is complete and ships dark until Stripe Tax
  // is activated in the dashboard (a true external action). Flip
  // STRIPE_TAX_ENABLED=true once registered.
  return process.env.STRIPE_TAX_ENABLED === "true";
}

/**
 * Reduce a previewed invoice down to the net proration of the simulated change.
 * Sums only the proration line items (the deltas Stripe would invoice now or
 * credit), so the caller can show "you'll be charged $X" / "we'll credit $X".
 */
function summarizeProration(
  preview: Stripe.Invoice,
  prorationDate: number,
): BillingProrationPreview {
  const prorationLines = (preview.lines?.data ?? [])
    .filter((l) => l.proration === true)
    .map((l) => ({
      description: l.description ?? "",
      amountCents: l.amount,
      proration: true,
    }));
  const amountCents = prorationLines.reduce((sum, l) => sum + l.amountCents, 0);
  return {
    amountCents,
    isCharge: amountCents > 0,
    currency: preview.currency,
    prorationDate,
    lines: prorationLines,
  };
}

function stripeDisputeToNeutral(d: Stripe.Dispute): BillingDispute {
  const chargeId =
    typeof d.charge === "string" ? d.charge : (d.charge?.id ?? null);
  const piRef = d.payment_intent;
  const paymentIntentId = piRef
    ? typeof piRef === "string"
      ? piRef
      : piRef.id
    : null;
  return {
    id: d.id,
    chargeId,
    paymentIntentId,
    amountCents: d.amount,
    currency: d.currency,
    reason: d.reason ?? null,
    status: d.status,
    orgId: (d.metadata?.org_id as string | undefined) ?? null,
  };
}

function stripeChargeToNeutral(c: Stripe.Charge): BillingRefundedCharge {
  const piRef = c.payment_intent;
  const paymentIntentId = piRef
    ? typeof piRef === "string"
      ? piRef
      : piRef.id
    : null;
  return {
    id: c.id,
    paymentIntentId,
    amountRefundedCents: c.amount_refunded,
    currency: c.currency,
    orgId: (c.metadata?.org_id as string | undefined) ?? null,
    metadata: (c.metadata as Record<string, string>) ?? {},
  };
}

/**
 * Whether Stripe has definitively answered that a charge cannot be read, as
 * opposed to failing to answer.
 *
 * Definitive: the id is wrong or the resource is gone
 * (`StripeInvalidRequestError`), or this key may not see it
 * (`StripePermissionError`). Retrying returns the same thing.
 *
 * Everything else — connection errors, 5xx, rate limits, authentication
 * faults — is the absence of an answer. Treating absence as "no metadata"
 * silently converts an outage into a dropped dispute, so those propagate.
 */
function isDefinitiveStripeReadFailure(err: unknown): boolean {
  const type = (err as { type?: unknown } | null)?.type;
  return (
    type === "StripeInvalidRequestError" || type === "StripePermissionError"
  );
}

/** Micro-dollars in one cent. */
const MICROS_PER_CENT = 10_000n;

/**
 * A per-GAU rate in micros as Stripe's `unit_amount_decimal`, which is in
 * cents: exact, at most four decimal places (6000 → "0.6", 12345 → "1.2345").
 * Stripe rounds the line once; the app computes no invoice amount.
 */
function microsToCentsDecimal(micros: bigint): string {
  const whole = micros / MICROS_PER_CENT;
  const fraction = (micros % MICROS_PER_CENT)
    .toString()
    .padStart(4, "0")
    .replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

/** The fields of a Stripe API error the settlement path classifies on. */
function stripeErrorFields(err: unknown): {
  rawType?: string;
  code?: string;
  message?: string;
} {
  return typeof err === "object" && err !== null ? err : {};
}

/**
 * Whether a failed `invoices.pay` leaves a finalized, unpaid invoice that
 * Stripe goes on collecting: a declined card, a payment that needs the
 * customer (SCA), or a customer with nothing to charge. Stripe gives the last
 * no error code, so it is matched on its message.
 */
function isUncollectedPayment(err: unknown): boolean {
  const { rawType, code, message } = stripeErrorFields(err);
  if (rawType === "card_error") return true;
  if (code === "invoice_payment_intent_requires_action") return true;
  return (
    rawType === "invalid_request_error" &&
    /no attached payment source/i.test(message ?? "")
  );
}

function isResourceMissing(err: unknown): boolean {
  return stripeErrorFields(err).code === "resource_missing";
}

// ── Stripe client singleton ──────────────────────────────────────────────────

let _stripe: Stripe | null = null;

/**
 * Raw Stripe client singleton. Exported for the `billing:stripe-sync` tooling
 * script, which legitimately needs direct Stripe Product/Price API access to
 * provision the catalog. Application/domain code must NOT use this — go through
 * the `BillingProvider` port (`billingProvider()`) to preserve vendor neutrality.
 */
export function stripeClient(): Stripe {
  if (_stripe) return _stripe;
  const env = requireEnv(["STRIPE_SECRET_KEY"] as const);
  _stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2025-02-24.acacia",
    typescript: true,
    appInfo: { name: "oxagen", version: "0.1.0" },
  });
  return _stripe;
}

// ── Translation helpers ──────────────────────────────────────────────────────

const ALLOWED_SUB_STATUSES = new Set<Stripe.Subscription.Status>([
  "trialing",
  "active",
  "past_due",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "unpaid",
  "paused",
]);

function toSubscriptionStatus(raw: string): BillingSubscriptionStatus {
  return ALLOWED_SUB_STATUSES.has(raw as Stripe.Subscription.Status)
    ? (raw as BillingSubscriptionStatus)
    : "incomplete";
}

function pickInterval(sub: Stripe.Subscription): "month" | "year" {
  const interval = sub.items.data[0]?.price?.recurring?.interval;
  return interval === "year" ? "year" : "month";
}

function resolveProductId(sub: Stripe.Subscription): string | null {
  const product = sub.items.data[0]?.price?.product;
  if (!product) return null;
  return typeof product === "string" ? product : product.id;
}

function resolveCustomerId(
  ref: string | Stripe.Customer | Stripe.DeletedCustomer,
): string {
  return typeof ref === "string" ? ref : ref.id;
}

function resolveSubscriptionRef(
  ref: string | Stripe.Subscription | null | undefined,
): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

/** A Stripe reference that is an id or an expanded object, to its id. */
function resolveRef(
  ref: string | { id: string } | null | undefined,
): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

function checkoutSessionToNeutral(
  sess: Stripe.Checkout.Session,
): BillingCheckoutSession {
  return {
    id: sess.id,
    mode: sess.mode ?? "",
    paymentStatus: sess.payment_status ?? "",
    customerId: resolveRef(sess.customer),
    metadata: (sess.metadata as Record<string, string>) ?? {},
    subscriptionId: resolveSubscriptionRef(sess.subscription),
    invoiceId: resolveRef(sess.invoice),
    paymentIntentId: resolveRef(sess.payment_intent),
    amountTotalCents: sess.amount_total ?? null,
  };
}

/**
 * Stripe's Basil-era API (2025-03-31+) REMOVED the top-level `Invoice.subscription`
 * field; an invoice's subscription reference and the subscription's metadata now
 * live under `invoice.parent.subscription_details`. A Stripe account renders
 * webhook payloads (and REST responses) at its OWN default API version regardless
 * of the SDK's pinned `apiVersion`, so once the account is on Basil+, invoices
 * arrive in the new shape even though the pinned stripe-node types (acacia) still
 * expose the legacy `subscription` field.
 *
 * Reading only `invoice.subscription` therefore yields null in production: that
 * nulls `BillingInvoice.subscriptionId`, which makes `grantPlanCreditsForInvoicePaid`
 * return at its `!invoice.subscriptionId` guard and `syncInvoiceFromStripe` fail to
 * resolve a tenant — so a free→paid upgrade's included credits are silently never
 * granted. Resolve the subscription id and the org id from BOTH shapes.
 */
interface InvoiceSubscriptionParent {
  subscription_details?: {
    subscription?: string | { id: string } | null;
    metadata?: Record<string, string> | null;
  } | null;
}

function invoiceParent(
  invoice: Stripe.Invoice,
): InvoiceSubscriptionParent | null {
  return (
    (invoice as unknown as { parent?: InvoiceSubscriptionParent | null })
      .parent ?? null
  );
}

function resolveInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  // Legacy top-level field (≤ acacia) first…
  const top = resolveSubscriptionRef(invoice.subscription);
  if (top) return top;
  // …then the Basil-era parent.subscription_details.subscription (string | {id}).
  const parentSub =
    invoiceParent(invoice)?.subscription_details?.subscription ?? null;
  if (!parentSub) return null;
  return typeof parentSub === "string" ? parentSub : parentSub.id;
}

function resolveInvoiceOrgId(invoice: Stripe.Invoice): string | null {
  const direct = (invoice.metadata?.org_id as string | undefined) ?? null;
  if (direct) return direct;
  // Subscription invoices stamp org_id on subscription_data.metadata, which now
  // surfaces here as parent.subscription_details.metadata — resolving it lets the
  // invoice bind to its tenant even before the subscription row is synced.
  return invoiceParent(invoice)?.subscription_details?.metadata?.org_id ?? null;
}

function stripeInvoiceToNeutral(invoice: Stripe.Invoice): BillingInvoice {
  const ALLOWED_INV_STATUSES = new Set([
    "draft",
    "open",
    "paid",
    "void",
    "uncollectible",
  ]);
  const status = ALLOWED_INV_STATUSES.has(invoice.status ?? "")
    ? (invoice.status as string)
    : "draft";

  const lineItems: BillingInvoiceLineItem[] = (invoice.lines?.data ?? []).map(
    (line) => ({
      description: line.description ?? "",
      quantity: line.quantity ?? 1,
      unitAmountCents: line.price?.unit_amount ?? 0,
      totalCents: line.amount,
      metric: (line.metadata?.metric as string | undefined) ?? null,
      metadata: (line.metadata as Record<string, string>) ?? {},
    }),
  );

  const orgId = resolveInvoiceOrgId(invoice);
  const subId = resolveInvoiceSubscriptionId(invoice);

  return {
    id: invoice.id,
    providerInvoiceId: invoice.id,
    number: invoice.number ?? null,
    status: status as BillingInvoice["status"],
    amountDueCents: invoice.amount_due,
    amountPaidCents: invoice.amount_paid,
    amountRemainingCents: invoice.amount_remaining,
    currency: invoice.currency,
    periodStart: new Date(invoice.period_start * 1000),
    periodEnd: new Date(invoice.period_end * 1000),
    dueAt: invoice.due_date ? new Date(invoice.due_date * 1000) : null,
    paidAt: invoice.status_transitions?.paid_at
      ? new Date(invoice.status_transitions.paid_at * 1000)
      : null,
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    invoicePdfUrl: invoice.invoice_pdf ?? null,
    subscriptionId: subId,
    orgId,
    billingReason: invoice.billing_reason ?? null,
    gauSettlementId:
      (invoice.metadata?.gau_settlement_id as string | undefined) ?? null,
    lineItems,
  };
}

function stripeSubscriptionToNeutral(
  sub: Stripe.Subscription,
): BillingSubscription {
  return {
    id: sub.id,
    customerId: resolveCustomerId(sub.customer),
    metadata: (sub.metadata as Record<string, string>) ?? {},
    status: toSubscriptionStatus(sub.status),
    billingInterval: pickInterval(sub),
    currentPeriodStart: new Date(sub.current_period_start * 1000),
    currentPeriodEnd: new Date(sub.current_period_end * 1000),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
    trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
    productId: resolveProductId(sub),
    seatCount: sub.items.data[0]?.quantity ?? 1,
  };
}

function stripePaymentMethodToNeutral(
  pm: Stripe.PaymentMethod,
): BillingPaymentMethod {
  const customerRef = pm.customer;
  const customerId = customerRef
    ? typeof customerRef === "string"
      ? customerRef
      : customerRef.id
    : "";
  return {
    id: pm.id,
    customerId,
    type: pm.type,
    brand: pm.card?.brand ?? null,
    last4: pm.card?.last4 ?? null,
    expMonth: pm.card?.exp_month ?? null,
    expYear: pm.card?.exp_year ?? null,
  };
}

function stripeEventType(stripeType: string): BillingWebhookEventType {
  switch (stripeType) {
    case "customer.subscription.created":
      return "subscription.created";
    case "customer.subscription.updated":
      return "subscription.updated";
    case "customer.subscription.deleted":
      return "subscription.deleted";
    case "customer.subscription.trial_will_end":
      return "subscription.trial_will_end";
    case "invoice.created":
      return "invoice.created";
    case "invoice.paid":
      return "invoice.paid";
    case "invoice.payment_failed":
      return "invoice.payment_failed";
    case "invoice.payment_action_required":
      return "invoice.payment_action_required";
    case "invoice.finalized":
      return "invoice.finalized";
    case "invoice.voided":
      return "invoice.voided";
    case "invoice.marked_uncollectible":
      return "invoice.marked_uncollectible";
    case "checkout.session.completed":
      return "checkout.session.completed";
    case "payment_method.attached":
      return "payment_method.attached";
    case "payment_method.detached":
      return "payment_method.detached";
    case "payment_method.updated":
    case "payment_method.automatically_updated":
      return "payment_method.updated";
    case "charge.dispute.created":
      return "dispute.created";
    case "charge.dispute.closed":
      return "dispute.closed";
    case "charge.refunded":
      return "charge.refunded";
    default:
      return "unknown";
  }
}

// ── StripeProvider ───────────────────────────────────────────────────────────

export class StripeProvider implements BillingProvider {
  /** The Stripe client every method operates against: the platform env singleton. */
  private client(): Stripe {
    return stripeClient();
  }

  // ── Customer ────────────────────────────────────────────────────────────────

  async findCustomerByOrgId(
    orgId: string,
  ): Promise<BillingCustomerSearchResult | null> {
    const stripe = this.client();
    const found = await stripe.customers.search({
      query: `metadata['org_id']:'${orgId}'`,
      limit: 1,
    });
    return found.data[0] ? { id: found.data[0].id } : null;
  }

  async createCustomer(input: BillingCustomerCreateInput): Promise<string> {
    const stripe = this.client();
    const customer = await stripe.customers.create({
      name: input.name,
      metadata: input.metadata,
    });
    return customer.id;
  }

  // ── Subscription ────────────────────────────────────────────────────────────

  async getSubscription(subscriptionId: string): Promise<BillingSubscription> {
    const sub = await this.client().subscriptions.retrieve(subscriptionId, {
      expand: ["items.data.price.product"],
    });
    return stripeSubscriptionToNeutral(sub);
  }

  async updateSubscription(
    subscriptionId: string,
    input: BillingSubscriptionUpdateInput,
  ): Promise<void> {
    const params: Stripe.SubscriptionUpdateParams = {};
    if (input.cancelAtPeriodEnd !== undefined) {
      params.cancel_at_period_end = input.cancelAtPeriodEnd;
    }
    await this.client().subscriptions.update(subscriptionId, params);
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    await this.client().subscriptions.cancel(subscriptionId);
  }

  async upgradeSubscription(
    subscriptionId: string,
    input: BillingSubscriptionUpgradeInput,
  ): Promise<void> {
    const stripe = this.client();
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const item = sub.items.data[0];
    if (!item) throw new Error("subscription has no items");
    const prorationBehavior = input.prorationBehavior ?? "always_invoice";
    await stripe.subscriptions.update(
      subscriptionId,
      {
        items: [{ id: item.id, price: input.newPriceId }],
        proration_behavior: prorationBehavior,
      },
      idempotency(input.idempotencyKey),
    );
  }

  async setSubscriptionSeats(
    subscriptionId: string,
    input: BillingSubscriptionSeatUpdateInput,
  ): Promise<void> {
    const stripe = this.client();
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const item = sub.items.data[0];
    if (!item) throw new Error("subscription has no items");
    // Increases default to immediate invoice (charge now); decreases pass
    // 'create_prorations' so the credit rolls to the next invoice — never an
    // immediate negative charge. The domain layer decides which.
    await stripe.subscriptions.update(
      subscriptionId,
      {
        items: [{ id: item.id, quantity: input.seats }],
        proration_behavior: input.prorationBehavior ?? "always_invoice",
      },
      idempotency(input.idempotencyKey),
    );
  }

  async previewSeatChange(
    subscriptionId: string,
    input: BillingSeatPreviewInput,
  ): Promise<BillingProrationPreview> {
    const stripe = this.client();
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const item = sub.items.data[0];
    if (!item) throw new Error("subscription has no items");
    const prorationDate = Math.floor(Date.now() / 1000);
    const preview = await stripe.invoices.createPreview({
      subscription: subscriptionId,
      subscription_details: {
        items: [{ id: item.id, quantity: input.seats }],
        proration_behavior: input.prorationBehavior ?? "always_invoice",
        proration_date: prorationDate,
      },
    });
    return summarizeProration(preview, prorationDate);
  }

  async previewPlanChange(
    subscriptionId: string,
    input: BillingPlanPreviewInput,
  ): Promise<BillingProrationPreview> {
    const stripe = this.client();
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const item = sub.items.data[0];
    if (!item) throw new Error("subscription has no items");
    const prorationDate = Math.floor(Date.now() / 1000);
    const preview = await stripe.invoices.createPreview({
      subscription: subscriptionId,
      subscription_details: {
        items: [{ id: item.id, price: input.newPriceId }],
        proration_behavior: input.prorationBehavior ?? "always_invoice",
        proration_date: prorationDate,
      },
    });
    return summarizeProration(preview, prorationDate);
  }

  // ── Payment methods ───────────────────────────────────────────────────────────

  async listPaymentMethods(
    customerId: string,
  ): Promise<BillingPaymentMethod[]> {
    const res = await this.client().paymentMethods.list({
      customer: customerId,
      type: "card",
    });
    return res.data.map(stripePaymentMethodToNeutral);
  }

  async getDefaultPaymentMethodId(customerId: string): Promise<string | null> {
    const cust = await this.client().customers.retrieve(customerId);
    if (cust.deleted) return null;
    const dpm = (cust as Stripe.Customer).invoice_settings
      ?.default_payment_method;
    if (!dpm) return null;
    return typeof dpm === "string" ? dpm : dpm.id;
  }

  async setDefaultPaymentMethod(
    customerId: string,
    paymentMethodId: string,
  ): Promise<void> {
    await this.client().customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
  }

  async detachPaymentMethod(paymentMethodId: string): Promise<void> {
    await this.client().paymentMethods.detach(paymentMethodId);
  }

  async createSetupIntent(customerId: string): Promise<BillingSetupIntent> {
    const si = await this.client().setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
      usage: "off_session",
    });
    if (!si.client_secret)
      throw new Error("Stripe did not return a SetupIntent client secret");
    return { clientSecret: si.client_secret, setupIntentId: si.id };
  }

  async chargeOffSession(
    input: BillingOffSessionChargeInput,
  ): Promise<BillingOffSessionChargeResult> {
    const stripe = this.client();
    // Resolve a card to charge: explicit > customer default. PaymentIntent
    // confirmation requires a concrete payment_method off-session.
    const paymentMethodId =
      input.paymentMethodId ??
      (await this.getDefaultPaymentMethodId(input.customerId));
    if (!paymentMethodId) {
      throw new Error("no payment method on file for off-session charge");
    }
    const pi = await stripe.paymentIntents.create(
      {
        customer: input.customerId,
        amount: input.amountCents,
        currency: "usd",
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        description: input.description,
        metadata: input.metadata,
      },
      idempotency(input.idempotencyKey),
    );
    return {
      paymentIntentId: pi.id,
      status: pi.status,
      succeeded: pi.status === "succeeded",
    };
  }

  // ── Invoice ─────────────────────────────────────────────────────────────────

  async getInvoice(invoiceId: string): Promise<BillingInvoice> {
    const invoice = await this.client().invoices.retrieve(invoiceId, {
      expand: ["lines.data.price"],
    });
    return stripeInvoiceToNeutral(invoice);
  }

  async createGauInvoice(
    input: BillingGauInvoiceInput,
  ): Promise<{ invoiceId: string }> {
    const stripe = this.client();
    const collection: Pick<
      Stripe.InvoiceCreateParams,
      "collection_method" | "default_payment_method" | "days_until_due"
    > =
      input.collection.method === "charge_automatically"
        ? {
            collection_method: "charge_automatically",
            default_payment_method: input.collection.defaultPaymentMethodId,
          }
        : {
            collection_method: "send_invoice",
            days_until_due: input.collection.daysUntilDue,
          };
    // auto_advance false: the draft stays a draft until
    // finalizeAndPayGauInvoice finalizes it, so a draft Oxagen abandons is
    // never collected (https://docs.stripe.com/invoicing/integration/automatic-advancement-collection).
    const invoice = await stripe.invoices.create(
      {
        customer: input.customerId,
        auto_advance: false,
        pending_invoice_items_behavior: "exclude",
        metadata: {
          org_id: input.orgId,
          oxagen_kind: input.kind,
          gau_settlement_id: input.settlementId,
          gau_quantity: String(input.quantityGau),
          rate_per_gau_micros: input.ratePerGauMicros.toString(),
          currency: input.currency,
        },
        ...collection,
      },
      { idempotencyKey: `${input.settlementId}:invoice` },
    );
    await stripe.invoiceItems.create(
      {
        customer: input.customerId,
        invoice: invoice.id,
        quantity: input.quantityGau,
        unit_amount_decimal: microsToCentsDecimal(input.ratePerGauMicros),
        currency: input.currency,
        description: input.description,
      },
      { idempotencyKey: `${input.settlementId}:item` },
    );
    return { invoiceId: invoice.id };
  }

  async finalizeAndPayGauInvoice(
    ref: BillingGauInvoiceRef,
  ): Promise<BillingGauInvoicePayment> {
    const stripe = this.client();
    let invoice = await stripe.invoices.retrieve(ref.invoiceId);
    if (invoice.status === "draft") {
      // auto_advance true from here: Stripe's collection and retry schedule
      // apply to the invoice Oxagen finalized.
      invoice = await stripe.invoices.finalizeInvoice(
        ref.invoiceId,
        { auto_advance: true },
        { idempotencyKey: `${ref.settlementId}:finalize` },
      );
    }
    if (
      invoice.status === "open" &&
      invoice.collection_method === "charge_automatically"
    ) {
      try {
        invoice = await stripe.invoices.pay(
          ref.invoiceId,
          { off_session: true },
          { idempotencyKey: `${ref.settlementId}:pay` },
        );
      } catch (err) {
        if (!isUncollectedPayment(err)) throw err;
      }
    }
    if (invoice.status !== "paid" && invoice.status !== "open") {
      throw new Error(
        `billing: settlement invoice ${ref.invoiceId} is ${invoice.status}, neither paid nor open`,
      );
    }
    return {
      status: invoice.status,
      amountCents: invoice.amount_due,
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    };
  }

  async deleteOrVoidDraftInvoice(
    ref: BillingGauInvoiceRef,
  ): Promise<{ outcome: BillingDraftInvoiceOutcome }> {
    const stripe = this.client();
    let invoice: Stripe.Invoice;
    try {
      invoice = await stripe.invoices.retrieve(ref.invoiceId);
    } catch (err) {
      if (isResourceMissing(err)) return { outcome: "absent" };
      throw err;
    }
    if (invoice.status === "void") return { outcome: "absent" };
    if (invoice.status === "paid") return { outcome: "paid" };
    if (invoice.status === "draft") {
      try {
        await stripe.invoices.del(ref.invoiceId);
      } catch (err) {
        if (isResourceMissing(err)) return { outcome: "absent" };
        throw err;
      }
      return { outcome: "deleted" };
    }
    await stripe.invoices.voidInvoice(
      ref.invoiceId,
      {},
      { idempotencyKey: `${ref.settlementId}:void` },
    );
    return { outcome: "voided" };
  }

  // ── Checkout ─────────────────────────────────────────────────────────────────

  async createSubscriptionCheckout(
    input: BillingCheckoutSubscriptionInput,
  ): Promise<BillingCheckoutResult> {
    const seats = input.seats ?? 1;
    const taxEnabled = automaticTaxEnabled();
    const session = await this.client().checkout.sessions.create({
      mode: "subscription",
      customer: input.customerId,
      line_items: [{ price: input.priceId, quantity: seats }],
      subscription_data: { metadata: input.subscriptionMetadata },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      allow_promotion_codes: true,
      automatic_tax: { enabled: taxEnabled },
      // Persist the address Checkout collects back onto the customer so Stripe
      // Tax can compute on subsequent invoices/renewals.
      customer_update: taxEnabled ? { address: "auto" } : undefined,
    });
    if (!session.url) throw new Error("Stripe did not return a checkout URL");
    return { sessionId: session.id, url: session.url };
  }

  async createPaymentCheckout(
    input: BillingCheckoutPaymentInput,
  ): Promise<BillingCheckoutResult> {
    const taxEnabled = automaticTaxEnabled();
    const session = await this.client().checkout.sessions.create({
      mode: "payment",
      customer: input.customerId,
      line_items: [{ price: input.priceId, quantity: input.quantity }],
      metadata: input.metadata,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      allow_promotion_codes: true,
      automatic_tax: { enabled: taxEnabled },
      customer_update: taxEnabled ? { address: "auto" } : undefined,
    });
    if (!session.url) throw new Error("Stripe did not return a checkout URL");
    return { sessionId: session.id, url: session.url };
  }

  async createDynamicCreditCheckout(
    input: BillingCheckoutDynamicCreditInput,
  ): Promise<BillingCheckoutResult> {
    const session = await this.client().checkout.sessions.create({
      mode: "payment",
      customer: input.customerId,
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: input.priceCents,
            product_data: {
              name: "Oxagen usage credits",
              metadata: { oxagen_kind: "usage_credits" },
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        org_id: input.orgId,
        credits: String(input.grantCents),
        gross_cents: String(input.grantCents),
        discount_percent: String(input.discountPercent),
      },
      payment_intent_data: {
        metadata: {
          org_id: input.orgId,
          credits: String(input.grantCents),
          gross_cents: String(input.grantCents),
          discount_percent: String(input.discountPercent),
        },
      },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      automatic_tax: { enabled: automaticTaxEnabled() },
      customer_update: automaticTaxEnabled() ? { address: "auto" } : undefined,
    });
    if (!session.url) throw new Error("Stripe did not return a checkout URL");
    return { sessionId: session.id, url: session.url };
  }

  async createGauCheckout(
    input: BillingCheckoutGauInput,
  ): Promise<BillingCheckoutResult> {
    const taxEnabled = automaticTaxEnabled();
    // The session and the invoice it issues carry the terms the purchase was
    // priced at. The webhook grant reads them from here and nowhere else, so
    // a paid session is self-sufficient (ADR-055 §6; ARCHITECTURE.md §3.9
    // item 11).
    const metadata = {
      oxagen_kind: "gau_purchase",
      org_id: input.orgId,
      gau_quantity: String(input.quantityGau),
      block_size_gau: String(input.quantityGau / input.blocks),
      rate_per_gau_micros: input.ratePerGauMicros.toString(),
      currency: input.currency,
    };
    const session = await this.client().checkout.sessions.create({
      mode: "payment",
      customer: input.customerId,
      line_items: [
        {
          price_data: {
            currency: input.currency,
            unit_amount: input.blockPriceCents,
            product_data: {
              name: "Oxagen governed action units",
              metadata: { oxagen_kind: "gau_block" },
            },
          },
          quantity: input.blocks,
        },
      ],
      metadata,
      invoice_creation: { enabled: true, invoice_data: { metadata } },
      // Card only: a delayed-notification method (ACH, SEPA, BACS) completes
      // the session unpaid and settles later on
      // `checkout.session.async_payment_succeeded`, which the webhook does
      // not dispatch; the grant reads `payment_status` on
      // `checkout.session.completed` alone. The card Checkout collects is
      // attached to the customer for the recorder's off-session auto top-up;
      // Checkout tells the customer so.
      payment_method_types: ["card"],
      // The same metadata on the PaymentIntent, which copies it onto the
      // Charge. A `charge.refunded` reads the charge and nothing else, so
      // without this the refund cannot name the organisation that was paid —
      // the credit-pack checkout has carried it since it was written
      // (createDynamicCreditCheckout above), and this one did not (ADR-085).
      // It is not sufficient on its own: a Stripe Dispute carries its own
      // metadata, not the charge's, which is why the grant also records the
      // PaymentIntent id on the settlement.
      payment_intent_data: { setup_future_usage: "off_session", metadata },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      automatic_tax: { enabled: taxEnabled },
      customer_update: taxEnabled ? { address: "auto" } : undefined,
    });
    if (!session.url) throw new Error("Stripe did not return a checkout URL");
    return { sessionId: session.id, url: session.url };
  }

  async getChargeMetadata(chargeId: string): Promise<Record<string, string>> {
    try {
      const charge = await this.client().charges.retrieve(chargeId);
      return (charge.metadata as Record<string, string>) ?? {};
    } catch (err) {
      if (isDefinitiveStripeReadFailure(err)) {
        // Stripe answered: this charge does not exist, or we may not read it.
        // Retrying cannot change that, and the caller's "no metadata" branch
        // is the correct one.
        logger.warn(
          { chargeId, err: err instanceof Error ? err.message : String(err) },
          "billing: charge cannot be read; treating as no metadata",
        );
        return {};
      }
      // A timeout, a 5xx or a rate limit is NOT an answer. Returning `{}` here
      // would tell the dispute handler the charge has no organisation and
      // nothing was bought, so the dispute would be dropped and the webhook
      // marked processed for ever — the exact defect ADR-085 §5 and §8 exist
      // to prevent, reached through a failed read instead of a missing field.
      //
      // Throwing is how this codebase asks for a retry: processStripeEvent
      // re-dispatches only an event whose handler threw, and Stripe's own
      // backoff is a better retry loop than one held open inside a webhook.
      logger.error(
        { chargeId, err: err instanceof Error ? err.message : String(err) },
        "billing: charge read failed transiently; failing the webhook so it is retried",
      );
      throw err;
    }
  }

  async getCheckoutPaymentMethod(
    sessionId: string,
  ): Promise<BillingCheckoutPaymentMethod | null> {
    // Two levels deep: under `payment_intent` alone, `payment_method` is a
    // string id and carries no card details.
    const sess = await this.client().checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent.payment_method"],
    });
    const pi = sess.payment_intent;
    if (!pi || typeof pi === "string") return null;
    const pm = pi.payment_method;
    if (!pm || typeof pm === "string") return null;
    return {
      id: pm.id,
      type: pm.type,
      brand: pm.card?.brand ?? null,
      last4: pm.card?.last4 ?? null,
      expMonth: pm.card?.exp_month ?? null,
      expYear: pm.card?.exp_year ?? null,
    };
  }

  async getCheckoutSessionCreditPacks(
    sessionId: string,
  ): Promise<BillingCreditPackLineItem[]> {
    const stripe = this.client();
    const lineItems = await stripe.checkout.sessions
      .listLineItems(sessionId, { expand: ["data.price.product"], limit: 100 })
      .autoPagingToArray({ limit: 10_000 });

    return lineItems.flatMap((item): BillingCreditPackLineItem[] => {
      const price = item.price;
      const product = price?.product;
      const creditsStr =
        price?.metadata?.credits ??
        (product && typeof product === "object" && "metadata" in product
          ? (product as Stripe.Product).metadata?.credits
          : undefined);
      const perUnit = creditsStr ? Number.parseInt(creditsStr, 10) : 0;
      if (!Number.isFinite(perUnit) || perUnit <= 0) return [];
      return [{ creditsPerUnit: perUnit, quantity: item.quantity ?? 1 }];
    });
  }

  // ── Webhook ─────────────────────────────────────────────────────────────────

  parseWebhookEvent(rawBody: string, signature: string): BillingWebhookEvent {
    const env = requireEnv(["STRIPE_WEBHOOK_SECRET"] as const);
    const event = this.client().webhooks.constructEvent(
      rawBody,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
    );

    const type = stripeEventType(event.type);
    const base = {
      providerEventId: event.id,
      apiVersion: event.api_version ?? null,
      type,
      rawPayload: event as unknown as Record<string, unknown>,
    };

    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.trial_will_end": {
        const sub = event.data.object as Stripe.Subscription;
        return { ...base, subscriptionId: sub.id };
      }
      case "invoice.created":
      case "invoice.paid":
      case "invoice.payment_failed":
      case "invoice.payment_action_required":
      case "invoice.finalized":
      case "invoice.voided":
      case "invoice.marked_uncollectible": {
        const inv = event.data.object as Stripe.Invoice;
        return { ...base, invoice: stripeInvoiceToNeutral(inv) };
      }
      case "charge.dispute.created":
      case "charge.dispute.closed": {
        const dispute = event.data.object as Stripe.Dispute;
        return { ...base, dispute: stripeDisputeToNeutral(dispute) };
      }
      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        return { ...base, refundedCharge: stripeChargeToNeutral(charge) };
      }
      case "checkout.session.completed": {
        const sess = event.data.object as Stripe.Checkout.Session;
        return { ...base, checkoutSession: checkoutSessionToNeutral(sess) };
      }
      case "payment_method.attached":
      case "payment_method.detached":
      case "payment_method.updated":
      case "payment_method.automatically_updated": {
        const pm = event.data.object as Stripe.PaymentMethod;
        return { ...base, paymentMethod: stripePaymentMethodToNeutral(pm) };
      }
      default:
        return base;
    }
  }
}
