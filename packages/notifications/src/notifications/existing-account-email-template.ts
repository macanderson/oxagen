/**
 * Branded HTML + plain-text template for the mail an account owner receives
 * when someone signs up with an address that already has an Oxagen account.
 *
 * Better Auth answers such a sign-up exactly as it answers a new one, so the
 * page cannot say the address is taken without revealing which addresses are
 * registered. This mail goes to the address itself. The owner learns of the
 * attempt, and a returning person gets the two links they need: log in, or
 * reset a forgotten password.
 *
 * Same structure as resetPasswordEmailTemplate: no external assets, no
 * template engine, and esc() on every value placed in HTML.
 */

import { esc } from "./html-escape";

export interface ExistingAccountEmailTemplateInput {
  /** The registered address the sign-up used. Shown in the greeting. */
  email: string;
  /** Absolute URL of the login page. */
  loginUrl: string;
  /** Absolute URL of the forgot-password page. */
  forgotPasswordUrl: string;
}

/**
 * Returns `{ subject, text, html }` for the existing-account mail.
 *
 * The mail carries no token. Both links are plain pages, so a forwarded or
 * leaked copy grants nothing.
 */
export function existingAccountEmailTemplate(
  input: ExistingAccountEmailTemplateInput,
): {
  subject: string;
  text: string;
  html: string;
} {
  const { email, loginUrl, forgotPasswordUrl } = input;

  const subject = "You already have an Oxagen account";

  const text = [
    `Hi,`,
    ``,
    `Someone tried to create an Oxagen account with ${email}. That address already has an account, so no new account was created.`,
    ``,
    `Log in: ${loginUrl}`,
    `Forgot your password? Reset it here: ${forgotPasswordUrl}`,
    ``,
    `If you did not try to sign up, you can ignore this mail. Your account and password have not changed.`,
    ``,
    `Oxagen`,
  ].join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;background:#f9fafb;margin:0;padding:32px 0">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #e5e7eb;padding:40px">
    <tr><td>
      <p style="font-size:14px;color:#374151;margin:0 0 16px">Hi,</p>
      <p style="font-size:14px;color:#374151;margin:0 0 16px">
        Someone tried to create an Oxagen account with
        <strong>${esc(email)}</strong>. That address already has an account,
        so no new account was created.
      </p>
      <p style="margin:0 0 24px">
        <a href="${esc(loginUrl)}"
           style="display:inline-block;background:#6366f1;color:#ffffff;font-size:14px;font-weight:600;padding:10px 20px;border-radius:6px;text-decoration:none">
          Log in
        </a>
      </p>
      <p style="font-size:14px;color:#374151;margin:0 0 16px">
        Forgot your password?
        <a href="${esc(forgotPasswordUrl)}" style="color:#6366f1">Reset it here</a>.
      </p>
      <p style="font-size:13px;color:#6b7280;margin:0">
        If you did not try to sign up, you can ignore this mail. Your account
        and password have not changed.
      </p>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}
