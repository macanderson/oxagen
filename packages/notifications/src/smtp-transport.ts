import nodemailer from "nodemailer";
import type { Address } from "nodemailer/lib/mailer";
import { logger } from "./logger";
import type {
  EmailTransport,
  SendEmailInput,
  SendEmailResult,
  SmtpTransportConfig,
} from "./types";

/**
 * Normalize nodemailer's `accepted` / `rejected` arrays (each entry is either a
 * bare string or an `{ address, name }` object) down to plain address strings,
 * so {@link SendEmailResult} never leaks a provider-specific shape.
 */
function toAddressStrings(
  list: ReadonlyArray<string | Address> | undefined,
): string[] {
  if (!list) return [];
  return list.map((entry) =>
    typeof entry === "string" ? entry : entry.address,
  );
}

/**
 * SMTP driver for the email transport, backed by nodemailer.
 *
 * SMTP is chosen over a provider's proprietary HTTP SDK deliberately: it is
 * provider-neutral by construction. Resend, SES, Postmark, and Mailgun all
 * speak SMTP, so switching providers is an env change with zero code change —
 * the vendor-neutrality seam the policy requires. Never import `nodemailer`
 * outside this file.
 */
export function createSmtpTransport(
  config: SmtpTransportConfig,
): EmailTransport {
  // Port 465 is implicit TLS; 587 and 25 negotiate STARTTLS. We require TLS on
  // the STARTTLS path (`requireTLS: true`) so a misconfigured server can never
  // silently downgrade a transactional email to plaintext on the wire.
  const secure = config.secure ?? config.port === 465;
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure,
    requireTLS: !secure,
    auth: { user: config.user, pass: config.pass },
  });

  // Pass structured From so nodemailer RFC-encodes display names that contain
  // spaces or parens (e.g. "Oxagen (DO NOT REPLY)") rather than us hand-quoting.
  const defaultFrom: string | Address = config.fromName
    ? { name: config.fromName, address: config.fromEmail }
    : config.fromEmail;

  return {
    driver: "smtp",

    async send(input: SendEmailInput): Promise<SendEmailResult> {
      const start = Date.now();
      const to = Array.isArray(input.to) ? input.to : [input.to];
      try {
        const info = await transporter.sendMail({
          from: input.from ?? defaultFrom,
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          replyTo: input.replyTo,
          subject: input.subject,
          text: input.text,
          html: input.html,
        });
        const result: SendEmailResult = {
          id: info.messageId,
          accepted: toAddressStrings(info.accepted),
          rejected: toAddressStrings(info.rejected),
        };
        // Instrument every send — recipient count, subject, latency, outcome.
        // The transport itself never logs an address or a message body. Note
        // that the failure paths outside this file (sendEmailFireAndForget,
        // notifyOrgManagers) currently DO log the recipient address, so this
        // file alone is not the whole PII story for the package.
        logger.info(
          {
            driver: "smtp",
            recipientCount: to.length,
            subject: input.subject,
            accepted: result.accepted.length,
            rejected: result.rejected.length,
            durationMs: Date.now() - start,
          },
          "notifications.email.send: sent",
        );
        return result;
      } catch (err) {
        logger.error(
          {
            driver: "smtp",
            recipientCount: to.length,
            subject: input.subject,
            err,
            durationMs: Date.now() - start,
          },
          "notifications.email.send: failed",
        );
        throw err;
      }
    },
  };
}
