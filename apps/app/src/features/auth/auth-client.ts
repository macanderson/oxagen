// Browser-side Better Auth calls (ARCHITECTURE.md §3.8), behind one seam so
// forms stay testable and so the Better Auth client (and its env reader) loads
// only when a live call runs. It is the one browser module that imports
// @oxagen/auth/client; the server half is src/server/session.ts. A destination
// Better Auth navigates to (the social sign-in `callbackURL`) is a SafePath.
import { routes, type SafePath, sanitizeNext } from "@/shared/safe-path";
import { type AuthOutcomeKey, authOutcomeKey } from "./auth-errors";
import { AFTER_SIGNUP } from "./routes";

export type ClientAuthResult =
  | { ok: true; twoFactor?: boolean; needsVerification?: boolean }
  | { ok: false; outcome: AuthOutcomeKey };

type BetterAuthReply = {
  data?: unknown;
  error?: { code?: string; status?: number; message?: string } | null;
};

/** Where a sign-in that stopped for a second factor resumes. Read by the two-factor form. */
const PENDING_NEXT_KEY = "oxagen.auth.next";
/** The address a sign-in that stopped for a second factor was for, shown back on the two-factor screen. */
const PENDING_EMAIL_KEY = "oxagen.auth.email";
/** A one-shot notice the next sign-in screen shows (the reset form's "Password set"). */
const NOTICE_KEY = "oxagen.auth.notice";

export type AuthNotice = "passwordSet";

/**
 * Set just before a sign-in leaves for its destination: the password form on
 * success, the two-factor form on success, and a social or SSO sign-in as it
 * leaves for the provider. The organization shell reads it once and shows
 * "Signed in as …" (mockups `obSignedIn`). A sign-in that fails comes back to
 * /login, which clears it, so a stale mark never reaches the shell.
 */
const SIGNED_IN_KEY = "oxagen.auth.signedIn";

async function client() {
  const { authClient } = await import("@oxagen/auth/client");
  return authClient;
}

function fail(reply: BetterAuthReply): ClientAuthResult | null {
  return reply.error
    ? { ok: false, outcome: authOutcomeKey(reply.error) }
    : null;
}

export async function liveSignIn(input: {
  email: string;
  password: string;
  rememberMe: boolean;
}): Promise<ClientAuthResult> {
  const reply: BetterAuthReply = await (await client()).signIn.email(input);
  const failed = fail(reply);
  if (failed) return failed;
  const { data } = reply;
  return {
    ok: true,
    twoFactor:
      typeof data === "object" &&
      data !== null &&
      "twoFactorRedirect" in data &&
      data.twoFactorRedirect === true,
  };
}

export async function liveSignUp(input: {
  name: string;
  email: string;
  password: string;
}): Promise<ClientAuthResult> {
  const reply: BetterAuthReply = await (await client()).signUp.email(input);
  const failed = fail(reply);
  if (failed) return failed;
  // With email verification required Better Auth creates the user but issues no session token.
  const { data } = reply;
  const token =
    typeof data === "object" && data !== null && "token" in data
      ? data.token
      : null;
  return { ok: true, needsVerification: !token };
}

export async function liveVerifyTwoFactor(input: {
  method: "totp" | "backup";
  code: string;
}): Promise<ClientAuthResult> {
  const c = await client();
  const reply =
    input.method === "totp"
      ? await c.twoFactor.verifyTotp({ code: input.code })
      : await c.twoFactor.verifyBackupCode({ code: input.code });
  return fail(reply) ?? { ok: true };
}

/** Social sign-in: Better Auth sends the browser to the provider, then back to `callbackURL`. */
export async function liveSignInSocial(input: {
  provider: "google" | "github";
  callbackURL: SafePath;
}): Promise<ClientAuthResult> {
  const reply: BetterAuthReply = await (await client()).signIn.social({
    provider: input.provider,
    callbackURL: input.callbackURL,
    // Failed provider round-trips land on /login?next=<callbackURL>&error=<code>
    // so the form can show the outcome and a retry still lands on the
    // destination the visitor asked for, rather than defaulting to "/".
    // Better Auth's default (`/?error=`) is gated and used to bury the code
    // inside `next` until the proxy lift landed.
    errorCallbackURL: routes.login(input.callbackURL),
  });
  return fail(reply) ?? { ok: true };
}

/**
 * Enterprise single sign-on. Better Auth finds the organization's identity
 * provider by the email's domain, and on success its client sends the browser
 * to that provider, which returns it to `callbackURL`. A refusal (no provider
 * for the domain, a domain not yet verified) comes back without leaving the
 * page.
 */
export async function liveSignInSso(input: {
  email: string;
  callbackURL: SafePath;
}): Promise<ClientAuthResult> {
  const reply: BetterAuthReply = await (await client()).signIn.sso({
    email: input.email,
    callbackURL: input.callbackURL,
    // The SSO plugin appends `?error=<code>` to this URL without checking for
    // a query it already has, so it must be a bare path: "/login?next=/x"
    // would come back as next="/x?error=…". The destination is lost on an
    // identity-provider failure, and the code alone tells the form it was SSO.
    errorCallbackURL: routes.login(),
  });
  return fail(reply) ?? { ok: true };
}

/**
 * The reply to a request that must not say whether an account exists. Only a
 * refusal from Better Auth's rate limiter is shown. Every other failure reads
 * as sent, the same as the reply for a registered address.
 */
function limitedOnly(reply: BetterAuthReply): ClientAuthResult {
  return reply.error && authOutcomeKey(reply.error) === "rateLimited"
    ? { ok: false, outcome: "rateLimited" }
    : { ok: true };
}

// The reset and verification calls below go over HTTP to /api/auth rather
// than through a server action, because Better Auth applies its rate limiter
// only in its HTTP router. A direct `auth.api.*` call on the server skipped
// it, which let anyone send reset and verification mail without limit (#4042).

/** Emails a reset link. Better Auth appends `?token=` to `redirectTo` and checks it against its trusted origins. */
export async function liveRequestPasswordReset(input: {
  email: string;
}): Promise<ClientAuthResult> {
  const reply: BetterAuthReply = await (await client()).requestPasswordReset({
    email: input.email,
    redirectTo: routes.resetPassword(),
  });
  return limitedOnly(reply);
}

/** Emails a new verification link that lands on `next` once verified, or on the new-organization step. */
export async function liveResendVerification(input: {
  email: string;
  next?: string;
}): Promise<ClientAuthResult> {
  const reply: BetterAuthReply = await (await client()).sendVerificationEmail({
    email: input.email,
    callbackURL: sanitizeNext(input.next ?? null, AFTER_SIGNUP),
  });
  return limitedOnly(reply);
}

/** Sets a new password from a reset link's token. */
export async function liveResetPassword(input: {
  token: string;
  newPassword: string;
}): Promise<ClientAuthResult> {
  const reply: BetterAuthReply = await (await client()).resetPassword({
    token: input.token,
    newPassword: input.newPassword,
  });
  if (!reply.error) return { ok: true };
  const outcome = authOutcomeKey(reply.error);
  // An unrecognised failure is an outage until shown otherwise. Calling it an
  // expired link would send the person for a new one that fails the same way.
  return {
    ok: false,
    outcome: outcome === "unknown" ? "unavailable" : outcome,
  };
}

export function rememberPendingNext(next: SafePath): void {
  try {
    sessionStorage.setItem(PENDING_NEXT_KEY, next);
  } catch {
    // Storage can be unavailable (private mode); the two-factor page then lands on "/".
  }
}

/** The stored destination, unsanitised: storage is page-writable, so the reader runs it through sanitizeNext. */
export function takePendingNext(): string | null {
  try {
    const value = sessionStorage.getItem(PENDING_NEXT_KEY);
    sessionStorage.removeItem(PENDING_NEXT_KEY);
    return value;
  } catch {
    return null;
  }
}

export function rememberPendingEmail(email: string): void {
  try {
    sessionStorage.setItem(PENDING_EMAIL_KEY, email);
  } catch {
    // Storage can be unavailable; the two-factor lead then omits the address.
  }
}

/** The address the password step was for. Read once; it is shown back to the person who typed it and never looked up. */
export function takePendingEmail(): string | null {
  try {
    const value = sessionStorage.getItem(PENDING_EMAIL_KEY);
    sessionStorage.removeItem(PENDING_EMAIL_KEY);
    return value;
  } catch {
    return null;
  }
}

export function rememberNotice(notice: AuthNotice): void {
  try {
    sessionStorage.setItem(NOTICE_KEY, notice);
  } catch {
    // Storage can be unavailable; the next screen then shows no notice.
  }
}

/** The notice left for this screen, read once. Anything but a known notice reads as none. */
export function takeNotice(): AuthNotice | null {
  try {
    const value = sessionStorage.getItem(NOTICE_KEY);
    sessionStorage.removeItem(NOTICE_KEY);
    return value === "passwordSet" ? value : null;
  } catch {
    return null;
  }
}

export function rememberSignedIn(): void {
  try {
    sessionStorage.setItem(SIGNED_IN_KEY, "1");
  } catch {
    // Storage can be unavailable; the destination then shows no toast.
  }
}

/** Whether a sign-in just landed here. Read once: the mark is removed as it is read. */
export function takeSignedIn(): boolean {
  try {
    const value = sessionStorage.getItem(SIGNED_IN_KEY);
    sessionStorage.removeItem(SIGNED_IN_KEY);
    return value === "1";
  } catch {
    return false;
  }
}
