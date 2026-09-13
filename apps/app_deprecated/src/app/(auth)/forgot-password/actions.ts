"use server";
/**
 * forgot-password/actions.ts — server action for requesting a password reset.
 *
 * Security contract (anti-enumeration):
 *   Always returns { ok: true } regardless of whether an account exists for
 *   the submitted email. The UI shows a neutral "if an account exists, we
 *   sent a link" message — never confirming or denying account existence.
 *
 * Pattern mirrors security-action.ts:
 *   - zod validation → typed result { ok: true } | { ok: false, error: string }
 *   - never throw past the action boundary
 */

import { z } from "zod";
import { auth } from "@oxagen/auth";
import { loadEnv } from "@oxagen/config/env";
import { logger } from "@oxagen/handlers/logger";
import { captureError } from "@oxagen/telemetry";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type RequestResetResult = { ok: true } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const RequestResetSchema = z.object({
  email: z.string().email("Enter a valid email address"),
});

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

/**
 * Trigger a password-reset email for the given email address.
 *
 * Always succeeds from the caller's perspective (anti-enumeration). The email
 * is sent (or silently skipped for unknown addresses) by Better Auth + the
 * sendResetPassword callback in packages/auth/src/auth.ts.
 *
 * The redirectTo URL points to the app's /reset-password page so Better Auth
 * generates a link the user can open in the browser. Better Auth appends the
 * token as a query parameter: /reset-password?token=<TOKEN>.
 */
export async function requestResetAction(
  input: z.infer<typeof RequestResetSchema>,
): Promise<RequestResetResult> {
  const parsed = RequestResetSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Enter a valid email address",
    };
  }

  // Resolve config OUTSIDE the anti-enumeration try. A broken environment is
  // identical for every email (nothing to enumerate), and swallowing it below
  // silently disabled reset emails while still reporting ok:true.
  let appBaseUrl: string;
  try {
    appBaseUrl = loadEnv().BETTER_AUTH_URL;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[forgot-password] loadEnv failed — reset email not sent",
    );
    return { ok: false, error: "Password reset is temporarily unavailable" };
  }

  try {
    await auth.api.requestPasswordReset({
      body: {
        email: parsed.data.email,
        redirectTo: `${appBaseUrl}/reset-password`,
      },
    });
  } catch (err) {
    // Anti-enumeration: the CLIENT response stays ok:true regardless (never
    // reveal whether an account exists or the send failed). But the failure
    // must NOT be silent server-side — a total reset-email outage (SES/SMTP
    // down, Better Auth send path throwing) would otherwise fail every request
    // while the UI reports success, indistinguishable from the expected
    // "no such account" no-op. Log + escalate so a spike is alertable. The
    // error message here is a transport/send failure, never the email address.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[forgot-password] requestPasswordReset threw — client response unaffected (anti-enumeration)",
    );
    captureError({
      error: err,
      source: "app",
      severity: "warn",
      context: "forgot-password: requestPasswordReset failed",
    });
  }

  // Always return ok:true (neutral response — anti-enumeration).
  return { ok: true };
}
