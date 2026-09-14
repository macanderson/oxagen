"use server";
// Server actions for the sign-in flows.
//
// Live sign-in, sign-up and two-factor run in the browser through the Better
// Auth client, which owns the session cookie. The server actions here cover the
// two password-reset legs and verification resend (all anti-enumeration: the
// reply never reveals whether an account exists); every input is re-validated
// here.
import { type AuthOutcomeKey, authOutcomeKey } from "./auth-errors";
import { AFTER_SIGNUP } from "./routes";
import { sanitizeNext } from "./safe-next";
import {
  type FieldErrors,
  ForgotPasswordSchema,
  ResendVerificationSchema,
  ResetPasswordSchema,
  fieldErrors,
} from "./schemas";

export type AuthActionResult =
  | { ok: true; to: string }
  | { ok: false; fields?: FieldErrors; outcome?: AuthOutcomeKey };

export async function requestPasswordReset(input: {
  email: string;
}): Promise<AuthActionResult> {
  const parsed = ForgotPasswordSchema.safeParse(input);
  if (!parsed.success) return { ok: false, fields: fieldErrors(parsed.error) };
  try {
    const { auth } = await import("@oxagen/auth/server");
    // A relative redirect: Better Auth appends ?token= and checks it against its trusted origins.
    await auth.api.requestPasswordReset({
      body: { email: parsed.data.email, redirectTo: "/reset-password" },
    });
  } catch (err) {
    // Anti-enumeration: the reply stays ok. A send outage must still be visible server-side.
    const { logger } = await import("@oxagen/handlers/logger");
    logger.warn(
      { outcome: authOutcomeKey(err) },
      "[forgot-password] requestPasswordReset failed; reply unaffected",
    );
  }
  return { ok: true, to: "/forgot-password" };
}

export async function resetPassword(input: {
  token: string;
  newPassword: string;
  confirmPassword: string;
}): Promise<AuthActionResult> {
  const parsed = ResetPasswordSchema.safeParse(input);
  if (!parsed.success) {
    const fields = fieldErrors(parsed.error);
    return fields.token
      ? { ok: false, outcome: "linkExpired" }
      : { ok: false, fields };
  }
  try {
    const { auth } = await import("@oxagen/auth/server");
    await auth.api.resetPassword({
      body: { token: parsed.data.token, newPassword: parsed.data.newPassword },
    });
    return { ok: true, to: "/login" };
  } catch (err) {
    const outcome = authOutcomeKey(err);
    if (outcome !== "linkExpired") {
      // Never log the password; the outcome key is enough to see an outage hiding behind "expired link".
      const { logger } = await import("@oxagen/handlers/logger");
      logger.warn({ outcome }, "[reset-password] resetPassword failed");
    }
    return {
      ok: false,
      outcome: outcome === "unknown" ? "linkExpired" : outcome,
    };
  }
}

export async function resendVerification(input: {
  email: string;
  next?: string;
}): Promise<AuthActionResult> {
  const parsed = ResendVerificationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, fields: fieldErrors(parsed.error) };
  try {
    const { auth } = await import("@oxagen/auth/server");
    await auth.api.sendVerificationEmail({
      body: {
        email: parsed.data.email,
        callbackURL: sanitizeNext(input.next, AFTER_SIGNUP),
      },
    });
  } catch (err) {
    const { logger } = await import("@oxagen/handlers/logger");
    logger.warn(
      { outcome: authOutcomeKey(err) },
      "[verify] sendVerificationEmail failed; reply unaffected",
    );
  }
  return { ok: true, to: "/verify" };
}
