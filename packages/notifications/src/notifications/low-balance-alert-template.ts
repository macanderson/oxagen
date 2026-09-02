/**
 * Branded HTML + plain-text template for low-balance alert emails.
 *
 * Same structure as resetPasswordEmailTemplate: no external assets, no template
 * engine, HTML-escaping via esc() for all user-derived values.
 */

import { esc } from "./html-escape";

export interface LowBalanceAlertTemplateInput {
  /** Organization/workspace name. */
  orgName: string;
  /** Current balance in cents (integer). */
  balanceCents: number;
  /** Threshold that triggered the alert, in cents (integer). */
  thresholdCents: number;
  /** URL to the top-up / add credits page. */
  topUpUrl: string;
}

/**
 * Formats cents as a dollar string (e.g. 1050 -> "$10.50").
 */
function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Returns `{ subject, text, html }` for the low-balance alert transactional email.
 */
export function lowBalanceAlertTemplate(input: LowBalanceAlertTemplateInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { orgName, balanceCents, thresholdCents, topUpUrl } = input;

  const balance = formatCents(balanceCents);
  const threshold = formatCents(thresholdCents);

  const subject = `Low balance alert for ${orgName}`;

  const text = [
    `Hi,`,
    ``,
    `The credit balance for ${orgName} on Oxagen has fallen below your configured threshold.`,
    ``,
    `Current balance: ${balance}`,
    `Threshold: ${threshold}`,
    ``,
    `Add credits to avoid service interruption: ${topUpUrl}`,
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
        The credit balance for <strong>${esc(orgName)}</strong> on Oxagen has
        fallen below your configured threshold.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;font-size:14px;color:#374151">
        <tr><td style="padding:4px 12px 4px 0;font-weight:600">Current balance:</td><td>${balance}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;font-weight:600">Threshold:</td><td>${threshold}</td></tr>
      </table>
      <p style="margin:0 0 24px">
        <a href="${esc(topUpUrl)}"
           style="display:inline-block;background:#6366f1;color:#ffffff;font-size:14px;font-weight:600;padding:10px 20px;border-radius:6px;text-decoration:none">
          Add credits
        </a>
      </p>
      <p style="font-size:13px;color:#6b7280;margin:0">
        Add credits to avoid service interruption.
      </p>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}
