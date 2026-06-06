// tenancy: system bypass via withSystemDb (resolves org from external Stripe invoice id
// before a tenant scope exists; webhook path, no per-org scope available) — OXA-1515
import { withSystemDb, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { billingProvider } from "./client";
import { logger } from "./logger";
import type { BillingInvoice } from "./provider";
import type { Tx } from "@oxagen/database";

async function resolveOrgIdFromSubscription(tx: Tx, invoice: BillingInvoice): Promise<string | null> {
  if (!invoice.subscriptionId) return null;
  const row = await tx.query.subscriptions.findFirst({
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

  await withSystemDb(async (tx) => {
    const orgId = invoice.orgId ?? (await resolveOrgIdFromSubscription(tx, invoice));
    if (!orgId) {
      logger.warn({ stripeInvoiceId }, "billing: cannot resolve org_id for invoice, skipping");
      return; // Can't bind to a tenant yet; skip.
    }

    const sub = invoice.subscriptionId
      ? await tx.query.subscriptions.findFirst({
          where: eq(schema.subscriptions.stripeSubscriptionId, invoice.subscriptionId),
          columns: { id: true },
        })
      : null;

    // Single row upsert + bulk line-item replace inside one transaction; the
    // line-item delete/insert pair is acceptable because invoices are mirrored
    // wholesale per event, not partially mutated.
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
      .where(
        and(
          eq(schema.invoiceLineItems.invoiceId, invoiceRowId),
          eq(schema.invoiceLineItems.orgId, orgId),
        ),
      );

    if (invoice.lineItems.length > 0) {
      await tx.insert(schema.invoiceLineItems).values(
        invoice.lineItems.map((line) => ({
          orgId,
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

    logger.info(
      { orgId, stripeInvoiceId, status: invoice.status, amountDueCents: invoice.amountDueCents, durationMs: Date.now() - start },
      "billing: invoice synced",
    );
  });
}
