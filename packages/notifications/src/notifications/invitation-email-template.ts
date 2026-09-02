/**
 * Branded HTML + plain-text template for workspace/org invitation emails.
 *
 * Same structure as resetPasswordEmailTemplate: no external assets, no template
 * engine, HTML-escaping via esc() for all user-derived values.
 */

import { esc } from "./html-escape";

export interface InvitationEmailTemplateInput {
  /** Full invitation URL that the recipient clicks to accept. */
  inviteUrl: string;
  /** Display name of the person who sent the invitation. */
  inviterName: string;
  /** Organization/workspace name being invited to. */
  orgName: string;
  /** Role being granted (e.g. "member", "admin"). */
  role: string;
  /** Invitee's email address. */
  email: string;
}

/**
 * Returns `{ subject, text, html }` for the org invitation transactional email.
 *
 * The invitation link expires after 7 days.
 */
export function invitationEmailTemplate(input: InvitationEmailTemplateInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { inviteUrl, inviterName, orgName, role, email } = input;

  const subject = `You've been invited to join ${orgName} on Oxagen`;

  const text = [
    `Hi,`,
    ``,
    `${inviterName} has invited you (${email}) to join ${orgName} on Oxagen as a ${role}.`,
    ``,
    `Accept your invitation here: ${inviteUrl}`,
    ``,
    `This invitation expires in 7 days. If you were not expecting this invitation, you can safely ignore this email.`,
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
        <strong>${esc(inviterName)}</strong> has invited you
        (<strong>${esc(email)}</strong>) to join
        <strong>${esc(orgName)}</strong> on Oxagen as a <strong>${esc(role)}</strong>.
      </p>
      <p style="margin:0 0 24px">
        <a href="${esc(inviteUrl)}"
           style="display:inline-block;background:#6366f1;color:#ffffff;font-size:14px;font-weight:600;padding:10px 20px;border-radius:6px;text-decoration:none">
          Accept invitation
        </a>
      </p>
      <p style="font-size:13px;color:#6b7280;margin:0 0 8px">
        This invitation expires in <strong>7 days</strong>. If you were not
        expecting this invitation, you can safely ignore this email.
      </p>
      <p style="font-size:12px;color:#9ca3af;margin:0">
        If the button above does not work, copy and paste this URL into your
        browser:<br>
        <span style="color:#6366f1;word-break:break-all">${esc(inviteUrl)}</span>
      </p>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}
