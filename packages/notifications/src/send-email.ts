import { emailTransport } from "./transport";
import { sendEmailInputSchema } from "./types";
import type { SendEmailInput, SendEmailResult } from "./types";

/**
 * Send a transactional email — the single entry point every surface uses.
 *
 * @example
 *   import { sendEmail } from "@oxagen/notifications";
 *
 *   await sendEmail({
 *     to: "user@example.com",
 *     subject: "Reset your password",
 *     html: "<p>Click the link…</p>",
 *   });
 *
 * Validates the payload against the shared schema, resolves the configured
 * transport (SMTP today), and dispatches. Throws on invalid input (Zod) or a
 * transport failure — the caller decides whether a failed notification is fatal
 * to its flow (e.g. block signup vs. log-and-continue).
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const payload = sendEmailInputSchema.parse(input);
  return emailTransport().send(payload);
}
