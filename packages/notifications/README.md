# @oxagen/notifications

Vendor-neutral transactional email for the Oxagen monorepo. One entry point,
`sendEmail`, dispatches welcome emails, password resets, invitations, and any
other transactional message from the API, app, or MCP server.

## Usage

```ts
import { sendEmail } from "@oxagen/notifications";

await sendEmail({
  to: "user@example.com",
  subject: "Reset your password",
  html: "<p>Click the link to reset your password.</p>",
  // text: "Plain-text alternative",   // text and/or html — at least one required
  // from: '"Support" <help@oxagen.ai>',   // overrides the default From
  // replyTo: "support@oxagen.ai",
  // cc / bcc: "addr" | ["addr", ...]
});
```

`to`, `cc`, and `bcc` accept a single address or an array. The call throws on
invalid input (validated with Zod) or a transport failure; the caller decides
whether a failed notification is fatal to its flow.

## Design

The package depends on an `EmailTransport` interface, never on a vendor SDK.
The only driver today is **SMTP** (`createSmtpTransport`, backed by nodemailer),
chosen over a provider's proprietary HTTP SDK precisely because SMTP is
provider-neutral: Resend, SES, Postmark, and Mailgun all speak it, so switching
providers is an environment change with **zero code change**. To add an HTTP
driver later, implement `EmailTransport` and branch on an `EMAIL_DRIVER` flag in
`transport.ts` — call sites stay on `sendEmail`.

Every send is instrumented through the package's pino logger (driver,
recipients, subject, accepted/rejected counts, latency, outcome) and never logs
the message body or other PII. Capability-level metering (org/workspace usage)
belongs at the handler that calls `sendEmail`, which holds that context.

## Configuration

Reads these env vars (declared in `@oxagen/config`'s registry; optional in the
base schema, enforced at first send):

| Var | Example | Notes |
|-----|---------|-------|
| `SMTP_HOST` | `smtp.resend.com` | SMTP server host |
| `SMTP_PORT` | `587` | 465 ⇒ implicit TLS; 587/25 ⇒ STARTTLS (TLS required) |
| `SMTP_USERNAME` | `resend` | Resend's SMTP username is the literal `resend` |
| `SMTP_PASSWORD` | `re_…` | secret — for Resend this is an API key |
| `SMTP_FROM_EMAIL` | `noreply@notifications.oxagen.ai` | default sender (domain must be verified) |
| `SMTP_FROM_NAME` | `Oxagen (DO NOT REPLY)` | optional default display name |
