import { withSystemDb, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import {
  notifyOrgManagers,
  paymentReceiptTemplate,
} from "@oxagen/notifications";
import { logger } from "./logger";
import { resolveOrgFromInvoice } from "./dunning";
import type { BillingInvoice } from "./provider";

/**
 * Human-readable description of what a paid invoice covered, for the receipt.
 * Prefers the line-item descriptions, then the invoice number / billing reason,
 * so the receipt always names what the customer paid for.
 */
function describeInvoice(invoice: BillingInvoice): string {
  const lineDescriptions = invoice.lineItems
    .map((li) => li.description)
    .filter((d): d is string => d.length > 0);
  if (lineDescriptions.length > 0) return lineDescriptions.join(", ");
  if (invoice.number) return `Invoice ${invoice.number}`;
  if (invoice.billingReason) return invoice.billingReason;
  return "Oxagen usage";
}

/**
 * URL the receipt's "View receipt" CTA points at. Prefers the provider-hosted
 * invoice page, then the PDF, then the app's billing settings — so the link
 * always resolves even when the provider omits a hosted URL.
 */
function receiptUrlForInvoice(invoice: BillingInvoice): string {
  if (invoice.hostedInvoiceUrl) return invoice.hostedInvoiceUrl;
  if (invoice.invoicePdfUrl) return invoice.invoicePdfUrl;
  const appUrl = process.env["APP_URL"] ?? "https://app.oxagen.sh";
  return `${appUrl}/settings/billing`;
}

/**
 * Email the org's billing managers a payment receipt when an invoice is paid.
 *
 * Called from the invoice.paid webhook branch (webhooks.ts). Mirrors the
 * payment-FAILURE path (onInvoicePaymentFailed in dunning.ts): resolves the org
 * + human-readable name inside a system-scoped read, then sends via
 * notifyOrgManagers with paymentReceiptTemplate.
 *
 * Best-effort: a send (or recipient-resolution) failure is logged and swallowed
 * so it can never fail — or roll back — the webhook. The billing state writes in
 * the invoice.paid branch (grants, dunning recovery) are the critical path.
 */
export async function sendPaymentReceipt(
  invoice: BillingInvoice,
): Promise<void> {
  const start = Date.now();

  // Skip zero-amount invoices. $0 trial-activation and pure-proration invoices
  // still fire invoice.paid, but there is no payment to acknowledge — a
  // "$0.00 receipt" is confusing noise, not a receipt.
  if (invoice.amountPaidCents <= 0) {
    logger.debug(
      { invoiceId: invoice.providerInvoiceId },
      "billing: receipt — skipping zero-amount invoice",
    );
    return;
  }

  // Resolve org id + name inside a system-scoped read (the webhook arrives with
  // no tenant scope; org is derived from the Stripe invoice). Capture the
  // context so notifyOrgManagers runs AFTER this read completes — it opens its
  // own withSystemDb and must never reuse this tx handle (its connection is
  // released back to the pool). Mirrors onInvoicePaymentFailed in dunning.ts.
  const notifyCtx = await withSystemDb(async (tx) => {
    // tenancy: system bypass via withSystemDb (org resolved from Stripe invoice, no workspace
    // context; billing is org_only; webhook path with no tenant scope).
    const orgId = await resolveOrgFromInvoice(tx, invoice);
    if (!orgId) {
      logger.warn(
        { invoiceId: invoice.providerInvoiceId },
        "billing: receipt — could not resolve orgId from invoice",
      );
      return null;
    }

    const orgRow = await tx.query.organizations.findFirst({
      where: eq(schema.organizations.id, orgId),
      columns: { name: true },
    });

    return { orgId, orgName: orgRow?.name ?? "your organization" };
  });

  if (!notifyCtx) return;

  // Best-effort notification: the billing state writes are the critical path, so
  // a receipt-email failure must never mask or roll them back. Awaited (not
  // fire-and-forget) so the attempt completes before the webhook handler returns
  // — a detached promise can be dropped when the serverless runtime freezes the
  // process. No tx handle is referenced here (its connection is already released).
  const { orgId, orgName } = notifyCtx;
  try {
    const template = paymentReceiptTemplate({
      orgName,
      amountCents: invoice.amountPaidCents,
      description: describeInvoice(invoice),
      receiptUrl: receiptUrlForInvoice(invoice),
    });
    await notifyOrgManagers({
      orgId,
      kind: "system",
      title: template.subject,
      body: `Your payment for ${orgName} was received. View your receipt in billing settings.`,
      emailHtml: template.html,
      deepLink: "/settings/billing",
    });
    logger.info(
      {
        orgId,
        invoiceId: invoice.providerInvoiceId,
        amountPaidCents: invoice.amountPaidCents,
        durationMs: Date.now() - start,
      },
      "billing: receipt — payment receipt sent",
    );
  } catch (err) {
    logger.warn(
      { orgId, err },
      "billing: receipt — failed to send payment receipt email",
    );
  }
}
