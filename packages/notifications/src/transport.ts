import { requireEnv } from "@oxagen/config/env";
import { createSmtpTransport } from "./smtp-transport";
import type { EmailTransport } from "./types";

/**
 * Resolve the configured email transport (one instance per process).
 *
 * Driver selection is config-only — today it is always SMTP, keyed by the
 * `SMTP_*` vars. To eject to a provider's HTTP API, add the driver and branch
 * here on an env flag (e.g. `EMAIL_DRIVER`); no call site changes.
 *
 * The `SMTP_*` vars are `.optional()` in the base env schema (not every service
 * sends mail), so we guard explicitly and fail closed with a precise error here
 * rather than letting nodemailer throw deep inside a connection attempt.
 */
let _transport: EmailTransport | null = null;

const REQUIRED_KEYS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USERNAME",
  "SMTP_PASSWORD",
  "SMTP_FROM_EMAIL",
] as const;

export function emailTransport(): EmailTransport {
  if (_transport) return _transport;

  const env = requireEnv([
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USERNAME",
    "SMTP_PASSWORD",
    "SMTP_FROM_EMAIL",
    "SMTP_FROM_NAME",
  ] as const);

  const missing = REQUIRED_KEYS.filter((key) => env[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `@oxagen/notifications: email is not configured — missing ${missing.join(", ")}. ` +
        "Set the SMTP_* environment variables to enable transactional email.",
    );
  }

  _transport = createSmtpTransport({
    // Non-null assertions are sound here: every REQUIRED_KEYS entry passed the
    // `missing` guard above, so these are present despite the optional schema.
    host: env.SMTP_HOST!,
    port: env.SMTP_PORT!,
    user: env.SMTP_USERNAME!,
    pass: env.SMTP_PASSWORD!,
    fromEmail: env.SMTP_FROM_EMAIL!,
    fromName: env.SMTP_FROM_NAME,
  });
  return _transport;
}

/**
 * Whether all required SMTP_* vars are present, WITHOUT building the transport or
 * throwing. Lets callers (e.g. auth boot) detect a deployed environment that
 * would silently fail every transactional email — such as the verification email
 * that gates production sign-in — and surface it loudly instead.
 */
export function isEmailTransportConfigured(): boolean {
  const env = requireEnv(REQUIRED_KEYS);
  return REQUIRED_KEYS.every((key) => env[key] !== undefined);
}

/** Reset the memoized transport. Test-only. */
export function __resetTransportForTests(): void {
  _transport = null;
}
