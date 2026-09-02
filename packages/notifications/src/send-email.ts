import { emailTransport } from "./transport";
import { logger } from "./logger";
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
export async function sendEmail(
  input: SendEmailInput,
): Promise<SendEmailResult> {
  const payload = sendEmailInputSchema.parse(input);
  return emailTransport().send(payload);
}

/**
 * Dispatch an email without blocking the caller, logging any failure instead of
 * swallowing it. For flows (Better Auth verification / password reset) that must
 * return synchronously for timing-attack reasons and therefore can't await the
 * send — a bare `void sendEmail(...)` would make a misconfigured transport
 * (e.g. missing SMTP_* in production) fail completely silently, so users never
 * receive the email that gates sign-in. This makes that failure observable.
 *
 * @param purpose short tag for the log line (e.g. "verification", "password-reset")
 */
export function sendEmailFireAndForget(
  input: SendEmailInput,
  purpose: string,
): void {
  void sendEmail(input).catch((error: unknown) => {
    logger.error(
      { err: error, purpose, to: input.to },
      "sendEmail failed (fire-and-forget) — recipient will not receive this email",
    );
  });
}
