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

Every send is logged through the package's pino logger: driver, recipient
count, subject, accepted/rejected counts, latency, and outcome. The message
body is never logged. The transport does not log recipient addresses either —
but two failure paths do, so that a lost email can be traced to a person:
`sendEmailFireAndForget` and `notifyOrgManagers` both include the recipient
address in their error log. Treat these logs as containing personal data.

Per-org and per-workspace usage metering is not done here. It belongs in the
handler that calls `sendEmail`, because that is the code that knows which org
and workspace the send belongs to.

## What happens when a send fails

There is no retry and no queue in this package. One `sendEmail` call is one
attempt against the SMTP server. If that attempt fails, the error is logged and
then handed to the caller, and the email is gone — nothing will try again
later.

That means the caller owns the retry decision:

- `sendEmail` throws. The caller chooses whether the failure is fatal to its
  flow (block the signup) or not (log and carry on).
- `sendEmailFireAndForget` never throws. It logs the failure and returns. Use
  it only where the caller must return immediately and a lost email is
  acceptable.
- `notifyOrgManagers` writes the in-app notification first, then tries the
  email. A failed email leaves the in-app notification in place with its
  `emailed_at` column still null.

A durable outbox — retries with backoff, and a record of messages that ran out
of attempts — would have to be built on top of this package, most likely as an
Inngest job.

## Configuration

Reads these env vars (declared in `@oxagen/config`'s registry; optional in the
base schema, enforced at first send):

| Var | Example | Notes |
|-----|---------|-------|
| `SMTP_HOST` | `smtp.resend.com` | SMTP server host |
| `SMTP_PORT` | `587` | 465 ⇒ implicit TLS; 587/25 ⇒ STARTTLS (TLS required) |
| `SMTP_USERNAME` | `resend` | Resend's SMTP username is the literal `resend` |
| `SMTP_PASSWORD` | `re_…` | secret — for Resend this is an API key |
| `SMTP_FROM_EMAIL` | `noreply@notifications.oxagen.sh` | default sender (domain must be verified) |
| `SMTP_FROM_NAME` | `Oxagen (DO NOT REPLY)` | optional default display name |
