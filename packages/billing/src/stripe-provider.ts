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
import type {
  BillingCreditPackLineItem,
  BillingCheckoutDynamicCreditInput,
  BillingCheckoutPaymentInput,
  BillingCheckoutResult,
  BillingCheckoutSession,
  BillingCheckoutSubscriptionInput,
  BillingCustomerCreateInput,
  BillingCustomerSearchResult,
  BillingInvoice,
  BillingInvoiceLineItem,
  BillingPaymentMethod,
  BillingProvider,
  BillingSubscription,
  BillingSubscriptionSeatUpdateInput,
  BillingSubscriptionStatus,
  BillingSubscriptionUpdateInput,
  BillingSubscriptionUpgradeInput,
  BillingWebhookEvent,
  BillingWebhookEventType,
} from "./provider";

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

function resolveCustomerId(ref: string | Stripe.Customer | Stripe.DeletedCustomer): string {
  return typeof ref === "string" ? ref : ref.id;
}

function resolveSubscriptionRef(ref: string | Stripe.Subscription | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

function stripeInvoiceToNeutral(invoice: Stripe.Invoice): BillingInvoice {
  const ALLOWED_INV_STATUSES = new Set(["draft", "open", "paid", "void", "uncollectible"]);
  const status = ALLOWED_INV_STATUSES.has(invoice.status ?? "") ? (invoice.status as string) : "draft";

  const lineItems: BillingInvoiceLineItem[] = (invoice.lines?.data ?? []).map((line) => ({
    description: line.description ?? "",
    quantity: line.quantity ?? 1,
    unitAmountCents: line.price?.unit_amount ?? 0,
    totalCents: line.amount,
    metric: (line.metadata?.metric as string | undefined) ?? null,
    metadata: (line.metadata as Record<string, string>) ?? {},
  }));

  const orgId = (invoice.metadata?.org_id as string | undefined) ?? null;
  const subId = resolveSubscriptionRef(invoice.subscription);

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
    lineItems,
  };
}

function stripeSubscriptionToNeutral(sub: Stripe.Subscription): BillingSubscription {
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

function stripePaymentMethodToNeutral(pm: Stripe.PaymentMethod): BillingPaymentMethod {
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
    case "invoice.created":
      return "invoice.created";
    case "invoice.paid":
      return "invoice.paid";
    case "invoice.payment_failed":
      return "invoice.payment_failed";
    case "checkout.session.completed":
      return "checkout.session.completed";
    case "payment_method.attached":
      return "payment_method.attached";
    case "payment_method.detached":
      return "payment_method.detached";
    default:
      return "unknown";
  }
}

// ── StripeProvider ───────────────────────────────────────────────────────────

export class StripeProvider implements BillingProvider {
  // ── Customer ────────────────────────────────────────────────────────────────

  async findCustomerByOrgId(orgId: string): Promise<BillingCustomerSearchResult | null> {
    const stripe = stripeClient();
    const found = await stripe.customers.search({
      query: `metadata['org_id']:'${orgId}'`,
      limit: 1,
    });
    return found.data[0] ? { id: found.data[0].id } : null;
  }

  async createCustomer(input: BillingCustomerCreateInput): Promise<string> {
    const stripe = stripeClient();
    const customer = await stripe.customers.create({
      name: input.name,
      metadata: input.metadata,
    });
    return customer.id;
  }

  // ── Subscription ────────────────────────────────────────────────────────────

  async getSubscription(subscriptionId: string): Promise<BillingSubscription> {
    const sub = await stripeClient().subscriptions.retrieve(subscriptionId, {
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
    await stripeClient().subscriptions.update(subscriptionId, params);
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    await stripeClient().subscriptions.cancel(subscriptionId);
  }

  async upgradeSubscription(
    subscriptionId: string,
    input: BillingSubscriptionUpgradeInput,
  ): Promise<void> {
    const stripe = stripeClient();
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const item = sub.items.data[0];
    if (!item) throw new Error("subscription has no items");
    const prorationBehavior = input.prorationBehavior ?? "always_invoice";
    await stripe.subscriptions.update(subscriptionId, {
      items: [{ id: item.id, price: input.newPriceId }],
      proration_behavior: prorationBehavior,
    });
  }

  async setSubscriptionSeats(
    subscriptionId: string,
    input: BillingSubscriptionSeatUpdateInput,
  ): Promise<void> {
    const stripe = stripeClient();
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const item = sub.items.data[0];
    if (!item) throw new Error("subscription has no items");
    await stripe.subscriptions.update(subscriptionId, {
      items: [{ id: item.id, quantity: input.seats }],
      proration_behavior: "always_invoice",
    });
  }

  // ── Invoice ─────────────────────────────────────────────────────────────────

  async getInvoice(invoiceId: string): Promise<BillingInvoice> {
    const invoice = await stripeClient().invoices.retrieve(invoiceId, {
      expand: ["lines.data.price"],
    });
    return stripeInvoiceToNeutral(invoice);
  }

  // ── Checkout ─────────────────────────────────────────────────────────────────

  async createSubscriptionCheckout(
    input: BillingCheckoutSubscriptionInput,
  ): Promise<BillingCheckoutResult> {
    const seats = input.seats ?? 1;
    const session = await stripeClient().checkout.sessions.create({
      mode: "subscription",
      customer: input.customerId,
      line_items: [{ price: input.priceId, quantity: seats }],
      subscription_data: { metadata: input.subscriptionMetadata },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      allow_promotion_codes: true,
    });
    if (!session.url) throw new Error("Stripe did not return a checkout URL");
    return { sessionId: session.id, url: session.url };
  }

  async createPaymentCheckout(
    input: BillingCheckoutPaymentInput,
  ): Promise<BillingCheckoutResult> {
    const session = await stripeClient().checkout.sessions.create({
      mode: "payment",
      customer: input.customerId,
      line_items: [{ price: input.priceId, quantity: input.quantity }],
      metadata: input.metadata,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      allow_promotion_codes: true,
    });
    if (!session.url) throw new Error("Stripe did not return a checkout URL");
    return { sessionId: session.id, url: session.url };
  }

  async createDynamicCreditCheckout(
    input: BillingCheckoutDynamicCreditInput,
  ): Promise<BillingCheckoutResult> {
    const session = await stripeClient().checkout.sessions.create({
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
    });
    if (!session.url) throw new Error("Stripe did not return a checkout URL");
    return { sessionId: session.id, url: session.url };
  }

  async getCheckoutSessionCreditPacks(
    sessionId: string,
  ): Promise<BillingCreditPackLineItem[]> {
    const stripe = stripeClient();
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
    const event = stripeClient().webhooks.constructEvent(
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
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        return { ...base, subscriptionId: sub.id };
      }
      case "invoice.created":
      case "invoice.paid":
      case "invoice.payment_failed": {
        const inv = event.data.object as Stripe.Invoice;
        return { ...base, invoice: stripeInvoiceToNeutral(inv) };
      }
      case "checkout.session.completed": {
        const sess = event.data.object as Stripe.Checkout.Session;
        const checkoutSession: BillingCheckoutSession = {
          id: sess.id,
          mode: sess.mode ?? "",
          paymentStatus: sess.payment_status ?? "",
          metadata: (sess.metadata as Record<string, string>) ?? {},
          subscriptionId: resolveSubscriptionRef(sess.subscription),
        };
        return { ...base, checkoutSession };
      }
      case "payment_method.attached":
      case "payment_method.detached": {
        const pm = event.data.object as Stripe.PaymentMethod;
        return { ...base, paymentMethod: stripePaymentMethodToNeutral(pm) };
      }
      default:
        return base;
    }
  }
}
