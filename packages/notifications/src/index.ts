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

// Notification service (in-app feed + email mirror)
export { createNotification } from "./notifications/create-notification";
export { notifyOrgManagers } from "./notifications/notify-org-managers";
export { reauthEmailTemplate } from "./notifications/email-templates";
export { resetPasswordEmailTemplate } from "./notifications/reset-password-email-template";
export type { ResetPasswordEmailTemplateInput } from "./notifications/reset-password-email-template";
export type {
  NotificationKind,
  NotificationRow,
  CreateNotificationInput,
} from "./notifications/types";
export type {
  NotificationRecipient,
  NotifyOrgManagersInput,
} from "./notifications/notify-org-managers";
