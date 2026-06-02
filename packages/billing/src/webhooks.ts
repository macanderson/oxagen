import { db, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { billingProvider } from "./client";
import { syncSubscriptionFromStripe } from "./subscriptions";
import { syncInvoiceFromStripe } from "./invoices";
import { grantPlanCreditsForInvoicePaid, grantCreditPackForCheckout } from "./grants";
import { logger } from "./logger";
import type { BillingWebhookEvent } from "./provider";

export function verifyStripeSignature(rawBody: string, signature: string): BillingWebhookEvent {
  return billingProvider().parseWebhookEvent(rawBody, signature);
}

/**
 * Idempotent processor. Three-phase contract:
 *
 * 1. INSERT the raw event into billing.stripe_events with ON CONFLICT DO
 *    NOTHING — the immutable append-only audit anchor (never UPDATEd; SOC2).
 *
 * 2. Decide whether to dispatch. We are a TRUE duplicate (skip) only if the
 *    event was already processed *successfully* — i.e. a stripe_event_processing
 *    row exists with processed_at set. If a prior attempt failed (no processing
 *    row, or one with only an error), we RE-DISPATCH so a provider retry
 *    self-heals instead of silently dropping the event. Every dispatch handler
 *    is idempotent (sync* upsert, grants key on a stable reference id), so
 *    re-dispatch never double-applies.
 *
 * 3. Dispatch, then upsert the processing row to record the outcome.
 */
export async function processStripeEvent(
  event: BillingWebhookEvent,
): Promise<{ status: "applied" | "duplicate" }> {
  const start = Date.now();
  const d = db();
  const inserted = await d
    .insert(schema.stripeEvents)
    .values({
      stripeEventId: event.providerEventId,
      eventType: event.type,
      apiVersion: event.apiVersion ?? null,
      payload: event.rawPayload,
    })
    .onConflictDoNothing({ target: schema.stripeEvents.stripeEventId })
    .returning({ id: schema.stripeEvents.id });

  let stripeEventRowId: string;
  if (inserted.length > 0) {
    stripeEventRowId = inserted[0]!.id;
  } else {
    // Already logged. Resolve its id and check whether a prior dispatch
    // succeeded; only then is this a real duplicate.
    const existing = await d.query.stripeEvents.findFirst({
      where: eq(schema.stripeEvents.stripeEventId, event.providerEventId),
      columns: { id: true },
    });
    if (!existing) return { status: "duplicate" };
    stripeEventRowId = existing.id;
    const processed = await d.query.stripeEventProcessing.findFirst({
      where: eq(schema.stripeEventProcessing.stripeEventId, stripeEventRowId),
      columns: { processedAt: true },
    });
    if (processed?.processedAt) return { status: "duplicate" };
    // No successful processing yet — fall through and (re-)dispatch.
  }

  try {
    await dispatch(event);
    // Record successful processing — upsert in case a prior attempt recorded
    // an error before we retried.
    await d
      .insert(schema.stripeEventProcessing)
      .values({ stripeEventId: stripeEventRowId, processedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.stripeEventProcessing.stripeEventId,
        set: { processedAt: new Date(), processingError: null },
      });
    logger.info({ eventId: event.providerEventId, type: event.type, durationMs: Date.now() - start }, "billing: webhook event applied");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await d
      .insert(schema.stripeEventProcessing)
      .values({ stripeEventId: stripeEventRowId, processingError: message })
      .onConflictDoUpdate({
        target: schema.stripeEventProcessing.stripeEventId,
        set: { processingError: message },
      });
    logger.error({ eventId: event.providerEventId, type: event.type, err: message, durationMs: Date.now() - start }, "billing: webhook event dispatch failed");
    throw err;
  }

  return { status: "applied" };
}

async function dispatch(event: BillingWebhookEvent): Promise<void> {
  switch (event.type) {
    case "subscription.created":
    case "subscription.updated":
    case "subscription.deleted": {
      if (!event.subscriptionId) return;
      await syncSubscriptionFromStripe(event.subscriptionId);
      return;
    }
    case "invoice.created":
    case "invoice.paid":
    case "invoice.payment_failed": {
      if (!event.invoice) return;
      await syncInvoiceFromStripe(event.invoice.providerInvoiceId);
      // Deposit the plan's included credits on the first invoice and every
      // renewal. Idempotent per event (ledger unique key).
      if (event.type === "invoice.paid") await grantPlanCreditsForInvoicePaid(event.invoice);
      return;
    }
    case "checkout.session.completed": {
      // One-time credit-pack purchases deposit their credits here. Subscription
      // checkouts (mode=subscription) deliver credits via invoice.paid instead.
      if (!event.checkoutSession) return;
      await grantCreditPackForCheckout(event.checkoutSession);
      return;
    }
    case "payment_method.attached":
    case "payment_method.detached": {
      if (!event.paymentMethod) return;
      await upsertPaymentMethod(
        event.type === "payment_method.detached" ? "detached" : "attached",
        event.paymentMethod,
      );
      return;
    }
    default:
      // Unhandled event types are intentionally retained in
      // billing.stripe_events with no processing row so the audit
      // trail surfaces gaps without crashing the webhook.
      return;
  }
}

async function upsertPaymentMethod(
  kind: "attached" | "detached",
  pm: import("./provider").BillingPaymentMethod,
): Promise<void> {
  if (!pm.customerId) return;

  // Org resolution: locate any subscription tied to this customer to get
  // the org id. New customers may not have a subscription yet; in that
  // case skip — the subsequent subscription.created event will backfill.
  const d = db();
  const sub = await d.query.subscriptions.findFirst({
    where: eq(schema.subscriptions.stripeCustomerId, pm.customerId),
    columns: { orgId: true },
  });
  if (!sub) return;

  if (kind === "detached") {
    await d
      .update(schema.paymentMethods)
      .set({ deletedAt: new Date() })
      .where(eq(schema.paymentMethods.stripePaymentMethodId, pm.id));
    logger.info({ customerId: pm.customerId, paymentMethodId: pm.id }, "billing: payment method detached");
    return;
  }

  await d
    .insert(schema.paymentMethods)
    .values({
      orgId: sub.orgId,
      stripeCustomerId: pm.customerId,
      stripePaymentMethodId: pm.id,
      type: pm.type,
      brand: pm.brand ?? null,
      last4: pm.last4 ?? null,
      expMonth: pm.expMonth ?? null,
      expYear: pm.expYear ?? null,
      isDefault: false,
    })
    .onConflictDoUpdate({
      target: schema.paymentMethods.stripePaymentMethodId,
      set: {
        brand: pm.brand ?? null,
        last4: pm.last4 ?? null,
        expMonth: pm.expMonth ?? null,
        expYear: pm.expYear ?? null,
        updatedAt: new Date(),
      },
    });
  logger.info({ orgId: sub.orgId, paymentMethodId: pm.id }, "billing: payment method upserted");
}
