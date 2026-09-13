"use server";
// Server actions for the sign-in flows.
//
// Live sign-in, sign-up and two-factor run in the browser through the Better
// Auth client, which owns the session cookie. The server actions here cover the
// two password-reset legs, verification resend (all anti-enumeration: the reply
// never reveals whether an account exists), and the fixture-mode stand-ins for
// the browser calls, which sign in the fixture operator by cookie. Every fixture
// action refuses outside fixture mode; every input is re-validated here.
import { cookies } from "next/headers";
import {
  FIXTURE_SESSION_COOKIE,
  FIXTURE_SESSION_VALUE,
  isFixtureMode,
} from "@/server/fixture-session";
import { type AuthOutcomeKey, authOutcomeKey } from "./auth-errors";
import { AFTER_SIGNUP } from "./routes";
import {
  FIXTURE_RESET_TOKEN,
  FIXTURE_TOTP_CODE,
  fixtureCredentialsMatch,
} from "./fixture";
import { sanitizeNext } from "./safe-next";
import {
  type FieldErrors,
  ForgotPasswordSchema,
  LoginSchema,
  ResendVerificationSchema,
  ResetPasswordSchema,
  SignupSchema,
  TwoFactorSchema,
  fieldErrors,
} from "./schemas";

export type AuthActionResult =
  | { ok: true; to: string }
  | { ok: false; fields?: FieldErrors; outcome?: AuthOutcomeKey };

const REFUSED: AuthActionResult = { ok: false, outcome: "unavailable" };

async function setFixtureSession(): Promise<void> {
  const store = await cookies();
  store.set(FIXTURE_SESSION_COOKIE, FIXTURE_SESSION_VALUE, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
}

export async function signInFixture(input: {
  email: string;
  password: string;
  rememberMe?: boolean;
  next?: string;
}): Promise<AuthActionResult> {
  if (!isFixtureMode()) return REFUSED;
  const parsed = LoginSchema.safeParse(input);
  if (!parsed.success) return { ok: false, fields: fieldErrors(parsed.error) };
  if (!fixtureCredentialsMatch(parsed.data.email, parsed.data.password)) {
    return { ok: false, outcome: "wrongCredentials" };
  }
  await setFixtureSession();
  return { ok: true, to: sanitizeNext(input.next) };
}

export async function signUpFixture(input: {
  name: string;
  email: string;
  password: string;
}): Promise<AuthActionResult> {
  if (!isFixtureMode()) return REFUSED;
  const parsed = SignupSchema.safeParse(input);
  if (!parsed.success) return { ok: false, fields: fieldErrors(parsed.error) };
  await setFixtureSession();
  return { ok: true, to: AFTER_SIGNUP };
}

export async function verifyTwoFactorFixture(input: {
  method: "totp" | "backup";
  code: string;
  next?: string;
}): Promise<AuthActionResult> {
  if (!isFixtureMode()) return REFUSED;
  const parsed = TwoFactorSchema.safeParse(input);
  if (!parsed.success) return { ok: false, fields: fieldErrors(parsed.error) };
  if (parsed.data.method !== "totp" || parsed.data.code !== FIXTURE_TOTP_CODE) {
    return { ok: false, outcome: "codeWrong" };
  }
  await setFixtureSession();
  return { ok: true, to: sanitizeNext(input.next) };
}

export async function requestPasswordReset(input: {
  email: string;
}): Promise<AuthActionResult> {
  const parsed = ForgotPasswordSchema.safeParse(input);
  if (!parsed.success) return { ok: false, fields: fieldErrors(parsed.error) };
  if (isFixtureMode()) return { ok: true, to: "/forgot-password" };
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
  if (isFixtureMode()) {
    return parsed.data.token === FIXTURE_RESET_TOKEN
      ? { ok: true, to: "/login" }
      : { ok: false, outcome: "linkExpired" };
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
  if (isFixtureMode()) return { ok: true, to: "/verify" };
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
