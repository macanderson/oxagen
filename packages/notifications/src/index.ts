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
export { sendEmail, sendEmailFireAndForget } from "./send-email";
export { emailTransport, isEmailTransportConfigured } from "./transport";
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
export { emailVerificationTemplate } from "./notifications/email-verification-template";
export type { EmailVerificationTemplateInput } from "./notifications/email-verification-template";
export { invitationEmailTemplate } from "./notifications/invitation-email-template";
export type { InvitationEmailTemplateInput } from "./notifications/invitation-email-template";
export { bookAccessEmailTemplate } from "./notifications/book-access-email-template";
export type { BookAccessEmailTemplateInput } from "./notifications/book-access-email-template";
export { lowBalanceAlertTemplate } from "./notifications/low-balance-alert-template";
export type { LowBalanceAlertTemplateInput } from "./notifications/low-balance-alert-template";
export { paymentFailedTemplate } from "./notifications/payment-failed-template";
export type { PaymentFailedTemplateInput } from "./notifications/payment-failed-template";
export { paymentReceiptTemplate } from "./notifications/payment-receipt-template";
export type { PaymentReceiptTemplateInput } from "./notifications/payment-receipt-template";
export type {
  NotificationKind,
  NotificationRow,
  CreateNotificationInput,
} from "./notifications/types";
export type {
  NotificationRecipient,
  NotifyOrgManagersInput,
} from "./notifications/notify-org-managers";
