// tenancy: system bypass via withSystemDb (webhook arrives with a Stripe event id, no org
// scope yet; stripe_events/stripe_event_processing are global audit tables; upsertPaymentMethod
// resolves orgId from the org's billing settings or a subscription lookup before writing).
import { withSystemDb, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { billingProvider } from "./client";
import { syncSubscriptionFromStripe } from "./subscriptions";
import { syncInvoiceFromStripe } from "./invoices";
import {
  grantPlanCreditsForInvoicePaid,
  grantCreditPackForCheckout,
} from "./grants";
import {
  grantGauPurchaseForCheckout,
  settleGauOpen,
  settleGauPaid,
} from "./gau-settlements";
import { onInvoicePaymentFailed, onInvoiceRecovered } from "./dunning";
import { closePrepaidOrder, grantPrepaidOrder } from "./prepaid-orders";
import { sendPaymentReceipt } from "./receipts";
import {
  onDisputeCreated,
  onDisputeClosed,
  onChargeRefunded,
} from "./disputes";
import { logger } from "./logger";
import type { BillingWebhookEvent } from "./provider";

export function verifyStripeSignature(
  rawBody: string,
  signature: string,
): BillingWebhookEvent {
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

  const { stripeEventRowId, isDuplicate } = await withSystemDb(async (tx) => {
    const inserted = await tx
      .insert(schema.stripeEvents)
      .values({
        stripeEventId: event.providerEventId,
        eventType: event.type,
        apiVersion: event.apiVersion ?? null,
        payload: event.rawPayload,
      })
      .onConflictDoNothing({ target: schema.stripeEvents.stripeEventId })
      .returning({ id: schema.stripeEvents.id });

    if (inserted.length > 0) {
      return { stripeEventRowId: inserted[0]!.id, isDuplicate: false };
    }

    // Already logged. Resolve its id and check whether a prior dispatch
    // succeeded; only then is this a real duplicate.
    const existing = await tx.query.stripeEvents.findFirst({
      where: eq(schema.stripeEvents.stripeEventId, event.providerEventId),
      columns: { id: true },
    });
    if (!existing) return { stripeEventRowId: "", isDuplicate: true };
    const processed = await tx.query.stripeEventProcessing.findFirst({
      where: eq(schema.stripeEventProcessing.stripeEventId, existing.id),
      columns: { processedAt: true },
    });
    return {
      stripeEventRowId: existing.id,
      isDuplicate: processed?.processedAt != null,
    };
  });

  if (isDuplicate) return { status: "duplicate" };

  try {
    await dispatch(event);
    // Record successful processing — upsert in case a prior attempt recorded
    // an error before we retried.
    await withSystemDb(async (tx) => {
      await tx
        .insert(schema.stripeEventProcessing)
        .values({ stripeEventId: stripeEventRowId, processedAt: new Date() })
        .onConflictDoUpdate({
          target: schema.stripeEventProcessing.stripeEventId,
          set: { processedAt: new Date(), processingError: null },
        });
    });
    logger.info(
      {
        eventId: event.providerEventId,
        type: event.type,
        durationMs: Date.now() - start,
      },
      "billing: webhook event applied",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withSystemDb(async (tx) => {
      await tx
        .insert(schema.stripeEventProcessing)
        .values({ stripeEventId: stripeEventRowId, processingError: message })
        .onConflictDoUpdate({
          target: schema.stripeEventProcessing.stripeEventId,
          set: { processingError: message },
        });
    });
    logger.error(
      {
        eventId: event.providerEventId,
        type: event.type,
        err: message,
        durationMs: Date.now() - start,
      },
      "billing: webhook event dispatch failed",
    );
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
    case "subscription.trial_will_end": {
      // Sync subscription state so our DB is current, then log.
      // Reminder notifications (email / banner) are triggered by the dunning
      // banner layer watching the subscription.trialEnd column.
      if (!event.subscriptionId) return;
      await syncSubscriptionFromStripe(event.subscriptionId);
      logger.info(
        { subscriptionId: event.subscriptionId },
        "billing: subscription trial will end — synced",
      );
      return;
    }
    case "invoice.created":
    case "invoice.paid":
    case "invoice.payment_failed": {
      if (!event.invoice) return;
      await syncInvoiceFromStripe(event.invoice.providerInvoiceId);
      // A governed-action settlement invoice (auto top-up, interim,
      // month-end) settles its ledger row. settleGauPaid grants once however
      // many times paid arrives, settleGauOpen touches only a pending row, and
      // neither invoice carries a subscription, so the dunning functions below
      // leave the org's dunning state alone (ADR-055 §6).
      const settlementId = event.invoice.gauSettlementId;
      if (settlementId !== null && event.type !== "invoice.created") {
        const paid = event.type === "invoice.paid";
        await withSystemDb((tx) =>
          paid
            ? settleGauPaid(tx, settlementId)
            : settleGauOpen(tx, settlementId),
        );
      }
      // A prepaid order (an enterprise's licence, units and credits invoiced
      // in advance) grants what it sold when its invoice is paid. The grant is
      // fenced per order, so a redelivery or a race with the issue-time grant
      // adds nothing twice.
      const prepaid = event.invoice.prepaidOrder ?? null;
      if (prepaid !== null && event.type === "invoice.paid") {
        await grantPrepaidOrder(prepaid.orderId, {
          trigger: "paid",
          stripeInvoiceId: event.invoice.providerInvoiceId,
          assistantSpendCap: prepaid.assistantSpendCap,
        });
      }
      // Deposit the plan's included credits on the first invoice and every
      // renewal. Idempotent per event (ledger unique key).
      if (event.type === "invoice.paid") {
        await grantPlanCreditsForInvoicePaid(event.invoice);
        await onInvoiceRecovered(event.invoice);
        // Email the customer a receipt. Runs last and is best-effort (never
        // throws), so it cannot trigger a re-dispatch of this event nor fail the
        // webhook.
        //
        // NOT exactly-once. The event-id dedup above only skips events whose
        // processing row already carries processed_at, and it is a read, not a
        // lock — so two concurrent deliveries of the same event both dispatch,
        // and a dispatch that succeeded but failed to record its processing row
        // is deliberately re-dispatched on the provider's retry. Both paths send
        // a second receipt. A per-invoice send guard belongs in receipts.ts if
        // duplicate receipts ever become a problem.
        await sendPaymentReceipt(event.invoice);
      }
      if (event.type === "invoice.payment_failed") {
        await onInvoicePaymentFailed(event.invoice);
      }
      return;
    }
    case "invoice.payment_action_required": {
      // SCA (Strong Customer Authentication) required — sync the invoice and
      // surface a warning. A banner/email is triggered externally by the
      // dunning/notification layer reading invoice status.
      if (!event.invoice) return;
      await syncInvoiceFromStripe(event.invoice.providerInvoiceId);
      logger.warn(
        {
          invoiceId: event.invoice.providerInvoiceId,
          orgId: event.invoice.orgId ?? null,
        },
        "billing: invoice.payment_action_required — SCA required; notify customer",
      );
      return;
    }
    case "invoice.finalized":
    case "invoice.voided":
    case "invoice.marked_uncollectible": {
      if (!event.invoice) return;
      await syncInvoiceFromStripe(event.invoice.providerInvoiceId);
      // A prepaid order mirrors its invoice closing unpaid. A grant already
      // made at issue stays made; closePrepaidOrder logs it for an operator.
      const prepaid = event.invoice.prepaidOrder ?? null;
      if (prepaid !== null && event.type !== "invoice.finalized") {
        await closePrepaidOrder(prepaid.orderId, {
          status: event.type === "invoice.voided" ? "void" : "uncollectible",
          stripeInvoiceId: event.invoice.providerInvoiceId,
        });
      }
      return;
    }
    case "checkout.session.completed": {
      // A governed-action block purchase (ADR-055 §6) grants its units here,
      // keyed on the session id. One-time credit-pack purchases deposit their
      // credits here too. Subscription checkouts (mode=subscription) deliver
      // credits via invoice.paid instead.
      if (!event.checkoutSession) return;
      if (event.checkoutSession.metadata.oxagen_kind === "gau_purchase") {
        await grantGauPurchaseForCheckout(event.checkoutSession);
        return;
      }
      await grantCreditPackForCheckout(event.checkoutSession);
      return;
    }
    case "payment_method.attached":
    case "payment_method.updated":
    case "payment_method.detached": {
      if (!event.paymentMethod) return;
      await upsertPaymentMethod(
        event.type === "payment_method.detached" ? "detached" : "attached",
        event.paymentMethod,
      );
      return;
    }
    case "dispute.created": {
      if (!event.dispute) return;
      await onDisputeCreated(event.dispute);
      return;
    }
    case "dispute.closed": {
      if (!event.dispute) return;
      await onDisputeClosed(event.dispute);
      return;
    }
    case "charge.refunded": {
      if (!event.refundedCharge) return;
      await onChargeRefunded(event.refundedCharge);
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

  await withSystemDb(async (tx) => {
    // tenancy: system bypass via withSystemDb (org resolved from Stripe customer id before
    // a tenant scope exists; payment_method events precede subscription scope).
    //
    // Org resolution: the org whose billing settings carry this customer
    // (written by ensureStripeCustomer, so a subscription-less Free org's
    // card events mirror too), then any subscription tied to it. A customer
    // known to neither is skipped — the subsequent subscription.created
    // event will backfill.
    const settings = await tx.query.orgBillingSettings.findFirst({
      where: eq(schema.orgBillingSettings.stripeCustomerId, pm.customerId!),
      columns: { orgId: true },
    });
    const sub =
      settings ??
      (await tx.query.subscriptions.findFirst({
        where: eq(schema.subscriptions.stripeCustomerId, pm.customerId!),
        columns: { orgId: true },
      }));
    if (!sub) return;

    if (kind === "detached") {
      await tx
        .update(schema.paymentMethods)
        .set({ deletedAt: new Date() })
        .where(eq(schema.paymentMethods.stripePaymentMethodId, pm.id));
      logger.info(
        { customerId: pm.customerId, paymentMethodId: pm.id },
        "billing: payment method detached",
      );
      return;
    }

    await tx
      .insert(schema.paymentMethods)
      .values({
        orgId: sub.orgId,
        stripeCustomerId: pm.customerId!,
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
    logger.info(
      { orgId: sub.orgId, paymentMethodId: pm.id },
      "billing: payment method upserted",
    );
  });
}
