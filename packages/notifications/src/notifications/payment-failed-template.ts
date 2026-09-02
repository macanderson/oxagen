/**
 * Branded HTML + plain-text template for payment-failed (dunning) emails.
 *
 * Same structure as resetPasswordEmailTemplate: no external assets, no template
 * engine, HTML-escaping via esc() for all user-derived values.
 */

import { esc } from "./html-escape";

export interface PaymentFailedTemplateInput {
  /** Organization/workspace name. */
  orgName: string;
  /** Number of grace days before service suspension. */
  graceDays: number;
  /** URL to the billing/payment method settings page. */
  billingUrl: string;
}

/**
 * Returns `{ subject, text, html }` for the payment-failed transactional email.
 *
 * Communicates the grace period and directs the user to update their payment method.
 */
export function paymentFailedTemplate(input: PaymentFailedTemplateInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { orgName, graceDays, billingUrl } = input;

  const subject = `Payment failed for ${orgName}`;

  const text = [
    `Hi,`,
    ``,
    `We were unable to process the latest payment for ${orgName} on Oxagen.`,
    ``,
    `You have ${graceDays} days to update your payment method before your account is suspended.`,
    ``,
    `Update your payment method here: ${billingUrl}`,
    ``,
    `If you have any questions, please reach out to our support team.`,
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
        We were unable to process the latest payment for
        <strong>${esc(orgName)}</strong> on Oxagen.
      </p>
      <p style="font-size:14px;color:#374151;margin:0 0 16px">
        You have <strong>${graceDays} days</strong> to update your payment method
        before your account is suspended.
      </p>
      <p style="margin:0 0 24px">
        <a href="${esc(billingUrl)}"
           style="display:inline-block;background:#6366f1;color:#ffffff;font-size:14px;font-weight:600;padding:10px 20px;border-radius:6px;text-decoration:none">
          Update payment method
        </a>
      </p>
      <p style="font-size:13px;color:#6b7280;margin:0 0 8px">
        If you have any questions, please reach out to our support team.
      </p>
      <p style="font-size:12px;color:#9ca3af;margin:0">
        If the button above does not work, copy and paste this URL into your
        browser:<br>
        <span style="color:#6366f1;word-break:break-all">${esc(billingUrl)}</span>
      </p>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}
