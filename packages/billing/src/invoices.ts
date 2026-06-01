import { db, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { billingProvider } from "./client.js";
import { logger } from "./logger.js";
import type { BillingInvoice } from "./provider.js";

async function resolveOrgIdFromSubscription(invoice: BillingInvoice): Promise<string | null> {
  if (!invoice.subscriptionId) return null;
  const d = db();
  const row = await d.query.subscriptions.findFirst({
    where: eq(schema.subscriptions.stripeSubscriptionId, invoice.subscriptionId),
    columns: { orgId: true, id: true },
  });
  return row?.orgId ?? null;
}

/**
 * Mirror a provider invoice into billing.invoices and its line items. Webhook
 * handler invokes this from invoice.* events; idempotent on stripe_invoice_id.
 */
export async function syncInvoiceFromStripe(stripeInvoiceId: string): Promise<void> {
  const start = Date.now();
  const invoice = await billingProvider().getInvoice(stripeInvoiceId);

  const orgId = invoice.orgId ?? (await resolveOrgIdFromSubscription(invoice));
  if (!orgId) {
    logger.warn({ stripeInvoiceId }, "billing: cannot resolve org_id for invoice, skipping");
    return; // Can't bind to a tenant yet; skip.
  }

  const d = db();
  const sub = invoice.subscriptionId
    ? await d.query.subscriptions.findFirst({
        where: eq(schema.subscriptions.stripeSubscriptionId, invoice.subscriptionId),
        columns: { id: true },
      })
    : null;

  // Single row upsert + bulk line-item replace inside one transaction; the
  // line-item delete/insert pair is acceptable because invoices are mirrored
  // wholesale per event, not partially mutated.
  await d.transaction(async (tx) => {
    const inserted = await tx
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
      })
      .returning({ id: schema.invoices.id });

    const invoiceRowId = inserted[0]?.id;
    if (!invoiceRowId) return;

    await tx
      .delete(schema.invoiceLineItems)
      .where(eq(schema.invoiceLineItems.invoiceId, invoiceRowId));

    if (invoice.lineItems.length > 0) {
      await tx.insert(schema.invoiceLineItems).values(
        invoice.lineItems.map((line) => ({
          invoiceId: invoiceRowId,
          description: line.description,
          quantity: String(line.quantity),
          unitAmountCents: line.unitAmountCents,
          totalCents: line.totalCents,
          metric: line.metric,
          metadata: line.metadata,
        })),
      );
    }
  });

  logger.info(
    { orgId, stripeInvoiceId, status: invoice.status, amountDueCents: invoice.amountDueCents, durationMs: Date.now() - start },
    "billing: invoice synced",
  );
}
