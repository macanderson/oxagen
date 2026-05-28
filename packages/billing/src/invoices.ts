import type Stripe from "stripe";
import { db, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { stripeClient } from "./client.js";

const ALLOWED_STATUSES = new Set(["draft", "open", "paid", "void", "uncollectible"]);

function resolveTenantIdFromMetadata(invoice: Stripe.Invoice): string | null {
  return (invoice.metadata?.tenant_id as string | undefined) ?? null;
}

async function resolveTenantIdFromSubscription(invoice: Stripe.Invoice): Promise<string | null> {
  const subRef = invoice.subscription;
  if (!subRef) return null;
  const subId = typeof subRef === "string" ? subRef : subRef.id;
  const d = db();
  const row = await d.query.subscriptions.findFirst({
    where: eq(schema.subscriptions.stripeSubscriptionId, subId),
    columns: { tenantId: true, id: true },
  });
  return row?.tenantId ?? null;
}

/**
 * Mirror a Stripe invoice into billing.invoices and its line items. Webhook
 * handler invokes this from invoice.* events; idempotent on
 * stripe_invoice_id.
 */
export async function syncInvoiceFromStripe(stripeInvoiceId: string): Promise<void> {
  const stripe = stripeClient();
  const invoice = await stripe.invoices.retrieve(stripeInvoiceId, {
    expand: ["lines.data.price"],
  });

  const tenantId =
    resolveTenantIdFromMetadata(invoice) ?? (await resolveTenantIdFromSubscription(invoice));
  if (!tenantId) return; // Can't bind to a tenant yet; skip.

  const subRef = invoice.subscription;
  const subId = subRef ? (typeof subRef === "string" ? subRef : subRef.id) : null;
  const d = db();
  const sub = subId
    ? await d.query.subscriptions.findFirst({
        where: eq(schema.subscriptions.stripeSubscriptionId, subId),
        columns: { id: true },
      })
    : null;

  const status = ALLOWED_STATUSES.has(invoice.status ?? "") ? (invoice.status as string) : "draft";

  // Single row upsert + bulk line-item replace inside one transaction; the
  // line-item delete/insert pair is acceptable because invoices are mirrored
  // wholesale per event, not partially mutated.
  await d.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.invoices)
      .values({
        tenantId,
        subscriptionId: sub?.id ?? null,
        stripeInvoiceId: invoice.id,
        number: invoice.number,
        status,
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
        hostedInvoiceUrl: invoice.hosted_invoice_url,
        invoicePdfUrl: invoice.invoice_pdf,
      })
      .onConflictDoUpdate({
        target: schema.invoices.stripeInvoiceId,
        set: {
          status,
          amountDueCents: invoice.amount_due,
          amountPaidCents: invoice.amount_paid,
          amountRemainingCents: invoice.amount_remaining,
          hostedInvoiceUrl: invoice.hosted_invoice_url,
          invoicePdfUrl: invoice.invoice_pdf,
          updatedAt: new Date(),
        },
      })
      .returning({ id: schema.invoices.id });

    const invoiceRowId = inserted[0]?.id;
    if (!invoiceRowId) return;

    await tx
      .delete(schema.invoiceLineItems)
      .where(eq(schema.invoiceLineItems.invoiceId, invoiceRowId));

    if (invoice.lines.data.length > 0) {
      await tx.insert(schema.invoiceLineItems).values(
        invoice.lines.data.map((line) => ({
          invoiceId: invoiceRowId,
          description: line.description ?? "",
          quantity: String(line.quantity ?? 1),
          unitAmountCents: line.price?.unit_amount ?? 0,
          totalCents: line.amount,
          metric: (line.metadata?.metric as string | undefined) ?? null,
          metadata: line.metadata ?? {},
        })),
      );
    }
  });
}
