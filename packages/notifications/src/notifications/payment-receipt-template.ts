/**
 * Branded HTML + plain-text template for payment receipt/success emails.
 *
 * Same structure as resetPasswordEmailTemplate: no external assets, no template
 * engine, HTML-escaping via esc() for all user-derived values.
 */

import { esc } from "./html-escape";

export interface PaymentReceiptTemplateInput {
  /** Organization/workspace name. */
  orgName: string;
  /** Payment amount in cents (integer). */
  amountCents: number;
  /** Description of what was purchased (e.g. "500 credits top-up"). */
  description: string;
  /** URL to view the full receipt. */
  receiptUrl: string;
}

/**
 * Formats cents as a dollar string (e.g. 1050 -> "$10.50").
 */
function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Returns `{ subject, text, html }` for the payment receipt transactional email.
 */
export function paymentReceiptTemplate(input: PaymentReceiptTemplateInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { orgName, amountCents, description, receiptUrl } = input;

  const amount = formatCents(amountCents);

  const subject = `Payment receipt for ${orgName}`;

  const text = [
    `Hi,`,
    ``,
    `We've received your payment for ${orgName} on Oxagen.`,
    ``,
    `Amount: ${amount}`,
    `Description: ${description}`,
    ``,
    `View your full receipt here: ${receiptUrl}`,
    ``,
    `Thank you for your business!`,
    ``,
    `— Oxagen`,
  ].join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;background:#f9fafb;margin:0;padding:32px 0">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #e5e7eb;padding:40px">
    <tr><td>
      <p style="font-size:14px;color:#374151;margin:0 0 16px">Hi,</p>
      <p style="font-size:14px;color:#374151;margin:0 0 16px">
        We've received your payment for <strong>${esc(orgName)}</strong> on Oxagen.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;font-size:14px;color:#374151">
        <tr><td style="padding:4px 12px 4px 0;font-weight:600">Amount:</td><td>${amount}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;font-weight:600">Description:</td><td>${esc(description)}</td></tr>
      </table>
      <p style="margin:0 0 24px">
        <a href="${esc(receiptUrl)}"
           style="display:inline-block;background:#6366f1;color:#ffffff;font-size:14px;font-weight:600;padding:10px 20px;border-radius:6px;text-decoration:none">
          View receipt
        </a>
      </p>
      <p style="font-size:13px;color:#6b7280;margin:0 0 8px">
        Thank you for your business!
      </p>
      <p style="font-size:12px;color:#9ca3af;margin:0">
        If the button above does not work, copy and paste this URL into your
        browser:<br>
        <span style="color:#6366f1;word-break:break-all">${esc(receiptUrl)}</span>
      </p>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}
