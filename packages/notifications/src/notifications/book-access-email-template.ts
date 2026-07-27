/**
 * Branded HTML + plain-text template for the ebook access email.
 *
 * Sent when a website lead captures the book (POST /v1/cms/leads) or asks for a
 * fresh link (POST /v1/cms/book/resend). Same structure as the other
 * notification templates: no external assets, no template engine, HTML-escaping
 * via esc() for every value that could contain user-derived content.
 *
 * The `readUrl` already carries the single-use access code as a query param;
 * callers pass the opaque URL as-is. The copy tells the reader the link is
 * personal and single-use so a forwarded/reused link failing later is expected,
 * not surprising.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface BookAccessEmailTemplateInput {
  /** Full reader URL including the single-use access code. */
  readUrl: string;
  /** Human title of the book. */
  bookTitle: string;
  /** Human title of the chosen edition (e.g. "Page-flip reader"). */
  editionTitle: string;
  /** Recipient email — used in the greeting line. */
  email: string;
}

/**
 * Returns `{ subject, text, html }` for the ebook access transactional email.
 */
export function bookAccessEmailTemplate(input: BookAccessEmailTemplateInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { readUrl, bookTitle, editionTitle, email } = input;

  const subject = `Your copy of ${bookTitle} is ready`;

  const text = [
    `Hi,`,
    ``,
    `Thanks for your interest in "${bookTitle}".`,
    ``,
    `Read it here (${editionTitle}): ${readUrl}`,
    ``,
    `This link is personal to you and single-use — each time the book is opened,`,
    `a fresh link is generated, so a shared or reused link will stop working.`,
    `Need a new link? Request one anytime from the book page.`,
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
        Thanks for your interest in <strong>${esc(bookTitle)}</strong>. Your copy
        is ready to read.
      </p>
      <p style="margin:0 0 24px">
        <a href="${esc(readUrl)}"
           style="display:inline-block;background:#6E48CE;color:#ffffff;font-size:14px;font-weight:600;padding:11px 22px;border-radius:8px;text-decoration:none">
          Read the book &rarr;</a>
      </p>
      <p style="font-size:13px;color:#6b7280;margin:0 0 8px">
        Edition: <strong>${esc(editionTitle)}</strong>
      </p>
      <p style="font-size:13px;color:#6b7280;margin:0 0 16px;line-height:1.6">
        This link is personal to you and single-use — every time the book is
        opened a fresh link is generated, so a shared or reused link will stop
        working. Need a new one? Request it anytime from the book page.
      </p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
      <p style="font-size:12px;color:#9ca3af;margin:0">
        Sent to ${esc(email)} because you requested the book on oxagen.sh.
      </p>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}
