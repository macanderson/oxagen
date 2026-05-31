import type Stripe from "stripe";
import { db, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { stripeClient } from "./client.js";
import { syncSubscriptionFromStripe } from "./subscriptions.js";
import { syncInvoiceFromStripe } from "./invoices.js";
import { requireEnv } from "@oxagen/config/env";

export function verifyStripeSignature(rawBody: string, signature: string): Stripe.Event {
  const env = requireEnv(["STRIPE_WEBHOOK_SECRET"] as const);
  return stripeClient().webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
}

/**
 * Idempotent processor. The contract is two-phase: insert the raw event
 * into billing.stripe_events with ON CONFLICT DO NOTHING so a retried
 * webhook is recognised before any state mutation, then dispatch. If the
 * insert produced zero rows, an earlier delivery already processed this
 * event and we exit fast.
 */
export async function processStripeEvent(event: Stripe.Event): Promise<{ status: "applied" | "duplicate" }> {
  const d = db();
  const inserted = await d
    .insert(schema.stripeEvents)
    .values({
      stripeEventId: event.id,
      eventType: event.type,
      apiVersion: event.api_version ?? null,
      payload: event as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing({ target: schema.stripeEvents.stripeEventId })
    .returning({ id: schema.stripeEvents.id });

  if (inserted.length === 0) return { status: "duplicate" };

  try {
    await dispatch(event);
    await d
      .update(schema.stripeEvents)
      .set({ processedAt: new Date() })
      .where(eq(schema.stripeEvents.stripeEventId, event.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await d
      .update(schema.stripeEvents)
      .set({ processingError: message })
      .where(eq(schema.stripeEvents.stripeEventId, event.id));
    throw err;
  }

  return { status: "applied" };
}

async function dispatch(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      await syncSubscriptionFromStripe(sub.id);
      return;
    }
    case "invoice.created":
    case "invoice.paid":
    case "invoice.payment_failed": {
      const inv = event.data.object as Stripe.Invoice;
      await syncInvoiceFromStripe(inv.id);
      return;
    }
    case "payment_method.attached":
    case "payment_method.detached": {
      await upsertPaymentMethod(event);
      return;
    }
    default:
      // Unhandled event types are intentionally retained in
      // billing.stripe_events with processed_at left null so the audit
      // trail surfaces gaps without crashing the webhook.
      return;
  }
}

async function upsertPaymentMethod(event: Stripe.Event): Promise<void> {
  const pm = event.data.object as Stripe.PaymentMethod;
  const customerRef = pm.customer;
  if (!customerRef) return;
  const customerId = typeof customerRef === "string" ? customerRef : customerRef.id;

  // Tenant resolution: locate any subscription tied to this customer to get
  // the tenant id. New customers may not have a subscription yet; in that
  // case skip — the subsequent subscription.created event will backfill.
  const d = db();
  const sub = await d.query.subscriptions.findFirst({
    where: eq(schema.subscriptions.stripeCustomerId, customerId),
    columns: { orgId: true },
  });
  if (!sub) return;

  if (event.type === "payment_method.detached") {
    await d
      .update(schema.paymentMethods)
      .set({ deletedAt: new Date() })
      .where(eq(schema.paymentMethods.stripePaymentMethodId, pm.id));
    return;
  }

  await d
    .insert(schema.paymentMethods)
    .values({
      orgId: sub.orgId,
      stripeCustomerId: customerId,
      stripePaymentMethodId: pm.id,
      type: pm.type,
      brand: pm.card?.brand ?? null,
      last4: pm.card?.last4 ?? null,
      expMonth: pm.card?.exp_month ?? null,
      expYear: pm.card?.exp_year ?? null,
      isDefault: false,
    })
    .onConflictDoUpdate({
      target: schema.paymentMethods.stripePaymentMethodId,
      set: {
        brand: pm.card?.brand ?? null,
        last4: pm.card?.last4 ?? null,
        expMonth: pm.card?.exp_month ?? null,
        expYear: pm.card?.exp_year ?? null,
        updatedAt: new Date(),
      },
    });
}
