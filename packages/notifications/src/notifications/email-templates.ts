/**
 * Minimal inline HTML template helper for transactional notification emails.
 * No template engine — just tagged-template string helpers to avoid
 * injecting unescaped user content into HTML.
 */

import { esc, safeHref } from "./html-escape";

export interface ReauthEmailTemplateInput {
  /** Short server name, e.g. "GitHub". */
  serverName: string;
  /** Full re-auth URL. */
  reauthUrl: string;
  /** Org name shown in the greeting. */
  orgName: string;
}

/**
 * Returns `{ subject, text, html }` for a credential needs-reauth notification.
 * The HTML is a minimal single-column layout with a CTA button — no external
 * assets or fonts (renders safely across all email clients).
 */
export function reauthEmailTemplate(input: ReauthEmailTemplateInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { serverName, reauthUrl, orgName } = input;
  const subject = `Action required: Reconnect ${esc(serverName)} in Oxagen`;
  const text = [
    `Hi,`,
    ``,
    `The ${serverName} MCP server in your Oxagen organization "${orgName}" needs to be reconnected — its OAuth token has expired or been revoked.`,
    ``,
    `Reconnect here: ${reauthUrl}`,
    ``,
    `If you did not set up this integration, you can ignore this email.`,
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
        The <strong>${esc(serverName)}</strong> MCP server in your Oxagen organization
        <strong>${esc(orgName)}</strong> needs to be reconnected — its OAuth token has
        expired or been revoked.
      </p>
      <p style="margin:0 0 24px">
        <a href="${safeHref(reauthUrl)}"
           style="display:inline-block;background:#6366f1;color:#ffffff;font-size:14px;font-weight:600;padding:10px 20px;border-radius:6px;text-decoration:none">
          Reconnect ${esc(serverName)}
        </a>
      </p>
      <p style="font-size:12px;color:#9ca3af;margin:0">
        If you did not set up this integration, you can safely ignore this email.
      </p>
    </td></tr>
  </table>
</body>
</html>`;
  return { subject, text, html };
}
