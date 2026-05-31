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
 * Idempotent processor. Two-phase contract:
 *
 * 1. INSERT the raw event into billing.stripe_events with ON CONFLICT DO
 *    NOTHING. A retried webhook yields zero rows → early return "duplicate".
 *    The stripe_events row is never UPDATEd after this point (immutable
 *    append-only anchor — SOC2 audit requirement).
 *
 * 2. Dispatch business logic, then INSERT (or upsert) a row in
 *    billing.stripe_event_processing to record the outcome. Processing state
 *    lives in a separate mutable table so the event log stays immutable.
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

  const stripeEventRowId = inserted[0]!.id;

  try {
    await dispatch(event);
    // Record successful processing — upsert in case a prior attempt recorded
    // an error and the operator is re-running the event manually.
    await d
      .insert(schema.stripeEventProcessing)
      .values({ stripeEventId: stripeEventRowId, processedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.stripeEventProcessing.stripeEventId,
        set: { processedAt: new Date(), processingError: null },
      });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await d
      .insert(schema.stripeEventProcessing)
      .values({ stripeEventId: stripeEventRowId, processingError: message })
      .onConflictDoUpdate({
        target: schema.stripeEventProcessing.stripeEventId,
        set: { processingError: message },
      });
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
      // billing.stripe_events with no processing row so the audit
      // trail surfaces gaps without crashing the webhook.
      return;
  }
}

async function upsertPaymentMethod(event: Stripe.Event): Promise<void> {
  const pm = event.data.object as Stripe.PaymentMethod;
  const customerRef = pm.customer;
  if (!customerRef) return;
  const customerId = typeof customerRef === "string" ? customerRef : customerRef.id;

  // Org resolution: locate any subscription tied to this customer to get
  // the org id. New customers may not have a subscription yet; in that
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
