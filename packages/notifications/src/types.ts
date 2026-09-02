import { z } from "zod";

/**
 * Vendor-neutral transactional-email contract.
 *
 * Every email in Oxagen is dispatched through {@link EmailTransport} so the
 * concrete backend (SMTP via nodemailer today; an HTTP provider tomorrow) is a
 * config-only swap — never an import-site change. App / API / MCP code depends
 * on `sendEmail` / `EmailTransport`, never on `nodemailer` directly. See the
 * vendor-neutrality policy.
 */

/** A single address or a non-empty list of addresses. */
const recipients = z.union([
  z.string().email(),
  z.array(z.string().email()).min(1),
]);

/**
 * The `sendEmail` payload. Shared by the facade and every transport so the
 * contract is declared exactly once. A message must carry at least one body —
 * `text`, `html`, or both (multipart/alternative).
 */
export const sendEmailInputSchema = z
  .object({
    /** Primary recipient(s). */
    to: recipients,
    /** Subject line. */
    subject: z.string().min(1),
    /** Plain-text body. Provide this, `html`, or both. */
    text: z.string().min(1).optional(),
    /** HTML body. Provide this, `text`, or both. */
    html: z.string().min(1).optional(),
    /**
     * Override the configured default `From`. Accepts a bare address or a full
     * `"Display Name" <addr>` header. Omit to use SMTP_FROM_NAME/SMTP_FROM_EMAIL.
     */
    from: z.string().min(1).optional(),
    /** Reply-To address. */
    replyTo: z.string().email().optional(),
    /** Carbon-copy recipient(s). */
    cc: recipients.optional(),
    /** Blind-carbon-copy recipient(s). */
    bcc: recipients.optional(),
  })
  .refine((v) => Boolean(v.text ?? v.html), {
    message: "Provide at least one of `text` or `html`.",
    path: ["text"],
  });

export type SendEmailInput = z.infer<typeof sendEmailInputSchema>;

/** Outcome of a dispatch. Addresses are normalized to plain strings. */
export interface SendEmailResult {
  /** Provider message id (RFC 5322 `Message-ID` where the provider returns one). */
  id: string;
  /** Addresses the provider accepted for delivery. */
  accepted: string[];
  /** Addresses the provider rejected. A non-empty list is a partial failure. */
  rejected: string[];
}

/**
 * The transport seam. Implement this to add a provider; the rest of the package
 * (and all callers) stay on this interface. `send` applies the transport's
 * default `From` when `input.from` is absent.
 */
export interface EmailTransport {
  /** Driver identifier, for logs/metrics (e.g. "smtp"). */
  readonly driver: string;
  /** Dispatch one validated message. */
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

/** Connection + identity config for the SMTP driver. */
export interface SmtpTransportConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** Default sender address used when a message omits `from`. */
  fromEmail: string;
  /** Optional default sender display name, paired with {@link fromEmail}. */
  fromName?: string;
  /**
   * Force implicit TLS. Defaults to `true` on port 465 and `false` (STARTTLS)
   * on every other port. Set explicitly only to override that inference.
   */
  secure?: boolean;
}
