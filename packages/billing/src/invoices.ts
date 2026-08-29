// tenancy: system bypass via withSystemDb (resolves org from external Stripe invoice id
// before a tenant scope exists; webhook path, no per-org scope available).
import { withSystemDb, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { billingProvider } from "./client";
import { logger } from "./logger";
import type { BillingInvoice } from "./provider";
import type { Tx } from "@oxagen/database";

async function resolveOrgIdFromSubscription(
  tx: Tx,
  invoice: BillingInvoice,
): Promise<string | null> {
  if (!invoice.subscriptionId) return null;
  const row = await tx.query.subscriptions.findFirst({
    where: eq(
      schema.subscriptions.stripeSubscriptionId,
      invoice.subscriptionId,
    ),
    columns: { orgId: true, id: true },
  });
  return row?.orgId ?? null;
}

/**
 * Mirror a provider invoice header into billing.invoices. Webhook handler
 * invokes this from invoice.* events; idempotent on stripe_invoice_id.
 * Line-item detail is NOT mirrored — the invoices UI links to the
 * Stripe-hosted invoice, and receipts read line items straight off the
 * provider payload.
 */
export async function syncInvoiceFromStripe(
  stripeInvoiceId: string,
): Promise<void> {
  const start = Date.now();
  const invoice = await billingProvider().getInvoice(stripeInvoiceId);

  await withSystemDb(async (tx) => {
    const orgId =
      invoice.orgId ?? (await resolveOrgIdFromSubscription(tx, invoice));
    if (!orgId) {
      logger.warn(
        { stripeInvoiceId },
        "billing: cannot resolve org_id for invoice, skipping",
      );
      return; // Can't bind to a tenant yet; skip.
    }

    const sub = invoice.subscriptionId
      ? await tx.query.subscriptions.findFirst({
          where: eq(
            schema.subscriptions.stripeSubscriptionId,
            invoice.subscriptionId,
          ),
          columns: { id: true },
        })
      : null;

    // Single-row header upsert; invoices are mirrored wholesale per event.
    await tx
      .insert(schema.invoices)
      .values({
        orgId,
        subscriptionId: sub?.id ?? null,
        stripeInvoiceId: invoice.providerInvoiceId,
        number: invoice.number,
        status: invoice.status,
        amountDueCents: invoice.amountDueCents,
        amountPaidCents: invoice.amountPaidCents,
        amountRemainingCents: invoice.amountRemainingCents,
        currency: invoice.currency,
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
        dueAt: invoice.dueAt,
        paidAt: invoice.paidAt,
        hostedInvoiceUrl: invoice.hostedInvoiceUrl,
        invoicePdfUrl: invoice.invoicePdfUrl,
      })
      .onConflictDoUpdate({
        target: schema.invoices.stripeInvoiceId,
        set: {
          status: invoice.status,
          amountDueCents: invoice.amountDueCents,
          amountPaidCents: invoice.amountPaidCents,
          amountRemainingCents: invoice.amountRemainingCents,
          hostedInvoiceUrl: invoice.hostedInvoiceUrl,
          invoicePdfUrl: invoice.invoicePdfUrl,
          updatedAt: new Date(),
        },
      });

    logger.info(
      {
        orgId,
        stripeInvoiceId,
        status: invoice.status,
        amountDueCents: invoice.amountDueCents,
        durationMs: Date.now() - start,
      },
      "billing: invoice synced",
    );
  });
}
