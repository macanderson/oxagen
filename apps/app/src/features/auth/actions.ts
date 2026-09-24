"use server";
// Server actions for the sign-in flows.
//
// Live sign-in, sign-up and two-factor run in the browser through the Better
// Auth client, which owns the session cookie. The server actions here cover the
// two password-reset legs and verification resend (all anti-enumeration: the
// reply never reveals whether an account exists); every input is re-validated
// here. The Better Auth calls go through the session seam.
import { captureError } from "@oxagen/telemetry";
import {
  requestPasswordReset as sendResetLink,
  resetPassword as setNewPassword,
  sendVerificationEmail,
} from "@/server/session";
import { routes, sanitizeNext } from "@/shared/safe-path";
import { type AuthOutcomeKey, authOutcomeKey } from "./auth-errors";
import { AFTER_SIGNUP } from "./routes";
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
    await sendResetLink({
      email: parsed.data.email,
      redirectTo: routes.resetPassword(),
    });
  } catch (err) {
    // Anti-enumeration: the reply stays ok. A send outage must still be visible
    // server-side; the report carries the outcome key, never the address.
    captureError({
      error: authOutcomeKey(err),
      source: "app",
      severity: "warn",
      context:
        "[forgot-password] requestPasswordReset failed; reply unaffected",
    });
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
    await setNewPassword({
      token: parsed.data.token,
      newPassword: parsed.data.newPassword,
    });
    return { ok: true, to: "/login" };
  } catch (err) {
    const outcome = authOutcomeKey(err);
    if (outcome !== "linkExpired") {
      // Never report the password; the outcome key is enough to see an outage hiding behind "expired link".
      captureError({
        error: outcome,
        source: "app",
        severity: "warn",
        context: "[reset-password] resetPassword failed",
      });
    }
    // An unrecognised failure is an outage until shown otherwise: calling it
    // an expired link would send the person for a new one that fails the same way.
    return {
      ok: false,
      outcome: outcome === "unknown" ? "unavailable" : outcome,
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
    await sendVerificationEmail({
      email: parsed.data.email,
      callbackURL: sanitizeNext(input.next ?? null, AFTER_SIGNUP),
    });
  } catch (err) {
    captureError({
      error: authOutcomeKey(err),
      source: "app",
      severity: "warn",
      context: "[verify] sendVerificationEmail failed; reply unaffected",
    });
  }
  return { ok: true, to: "/verify" };
}
