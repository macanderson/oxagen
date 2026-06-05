/**
 * @oxagen/notifications — vendor-neutral transactional email.
 *
 * Public surface:
 *   sendEmail(input)            → dispatch a transactional email (the one entry point)
 *   emailTransport()            → the configured EmailTransport singleton (advanced)
 *   createSmtpTransport(config) → construct the SMTP driver explicitly (custom/tests)
 *   sendEmailInputSchema        → the shared Zod payload schema (reuse for validation)
 *   EmailTransport, SendEmail*  → the adapter + payload contract types
 *
 * Never import `nodemailer` outside this package — depend on `EmailTransport`.
 */
export { sendEmail } from "./send-email";
export { emailTransport } from "./transport";
export { createSmtpTransport } from "./smtp-transport";
export { sendEmailInputSchema } from "./types";
export type {
  EmailTransport,
  SendEmailInput,
  SendEmailResult,
  SmtpTransportConfig,
} from "./types";
